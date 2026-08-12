const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EXPECTED_BASE_SCHEMA_VERSION,
  EXPECTED_CONFIGURED_NHL_SEASON_KEY,
  EXPECTED_MIGRATION_CHECKSUM_SET_SHA256,
  EXPECTED_MIGRATION_COUNT,
  EXPECTED_NODE_VERSION,
  EXPECTED_POST_BASE_MIGRATION_COUNT,
  EXPECTED_POST_RESET_POLICY_SHA256,
  EXPECTED_POST_RESET_REQUIRE_EMPTY_COUNT,
  EXPECTED_PROBE_MANIFEST_RELATIVE_PATH,
  EXPECTED_PROBE_NHL_SEASON_KEY,
  EXPECTED_REPOSITORY_CATALOG_COUNT,
  EXPECTED_REPOSITORY_CATALOG_SHA256,
  EXPECTED_SCHEMA_VERSION,
  evaluateReleaseCandidatePreflight,
  inspectBackendReleaseFacts,
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
const MANIFEST_HASH = "d".repeat(64);

function backendReleaseFacts(overrides = {}) {
  return Object.freeze({
    migrationSource: Object.freeze({
      baseSchemaVersion: EXPECTED_BASE_SCHEMA_VERSION,
      targetSchemaVersion: EXPECTED_SCHEMA_VERSION,
      migrationCount: EXPECTED_MIGRATION_COUNT,
      postBaseMigrationCount: EXPECTED_POST_BASE_MIGRATION_COUNT,
      contiguous: true,
      checksumSetSha256:
        EXPECTED_MIGRATION_CHECKSUM_SET_SHA256,
      ...overrides.migrationSource,
    }),
    repositorySource: Object.freeze({
      repositoryCatalogCount:
        EXPECTED_REPOSITORY_CATALOG_COUNT,
      repositoryCatalogSha256:
        EXPECTED_REPOSITORY_CATALOG_SHA256,
      postResetRequireEmptyCount:
        EXPECTED_POST_RESET_REQUIRE_EMPTY_COUNT,
      postResetPolicySha256:
        EXPECTED_POST_RESET_POLICY_SHA256,
      resetPolicyCoverageValid: true,
      ...overrides.repositorySource,
    }),
    probeManifest: Object.freeze({
      relativePath:
        EXPECTED_PROBE_MANIFEST_RELATIVE_PATH,
      exists: false,
      tracked: false,
      valid: false,
      manifestSha256: null,
      configuredNhlSeasonKey: null,
      probeNhlSeasonKey: null,
      ...overrides.probeManifest,
    }),
    renderProbe: Object.freeze({
      nodeMode: "production",
      maintenanceHold: "false",
      liveMode: "disabled",
      leagueWriteMode: "closed",
      scheduledJobsEnabled: "false",
      freeAgentDraftRoutesEnabled: "false",
      accountEmailDeliveryEnabled: "false",
      debugRoutesEnabled: "false",
      emailDeliveryMode: "capture",
      backupScheduleEnabled: "false",
      forbiddenEmailInputs: Object.freeze([]),
      forbiddenLiveProviderInputs: Object.freeze([]),
      safe: true,
      ...overrides.renderProbe,
    }),
  });
}

function repository(name, overrides = {}) {
  return Object.freeze({
    name,
    branch: "staging",
    commit: name === "frontend" ? FRONTEND_COMMIT : BACKEND_COMMIT,
    dirtyEntryCount: 0,
    configurationSha256: Object.freeze({ "package-lock.json": FILE_HASH }),
    ...(name === "backend"
      ? { releaseFacts: backendReleaseFacts() }
      : {}),
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

test("release-candidate preflight ignores absent optional provider evidence while blocking every drifted schema source fact", () => {
  const report = evaluateReleaseCandidatePreflight({
    frontend: repository("frontend"),
    backend: repository("backend", {
      releaseFacts: backendReleaseFacts({
        migrationSource: {
          targetSchemaVersion: 48,
          migrationCount: 48,
          postBaseMigrationCount: 26,
          contiguous: false,
          checksumSetSha256: "e".repeat(64),
        },
        repositorySource: {
          repositoryCatalogCount: 130,
          repositoryCatalogSha256: "f".repeat(64),
          postResetRequireEmptyCount: 48,
          postResetPolicySha256: "0".repeat(64),
          resetPolicyCoverageValid: false,
        },
        probeManifest: {
          exists: false,
          tracked: false,
          valid: false,
          manifestSha256: null,
          configuredNhlSeasonKey: null,
          probeNhlSeasonKey: null,
        },
        renderProbe: {
          leagueWriteMode: "open",
          forbiddenEmailInputs: Object.freeze(["RESEND_API_KEY"]),
          safe: true,
        },
      }),
    }),
    candidate: {
      releaseId: "HL-20260722-1",
      frontendCommit: FRONTEND_COMMIT,
      backendCommit: BACKEND_COMMIT,
    },
    nodeVersion: EXPECTED_NODE_VERSION,
  });
  assert.deepEqual(report.blockers, [
    "BACKEND_SCHEMA_TARGET_MISMATCH",
    "BACKEND_MIGRATION_SEQUENCE_INVALID",
    "BACKEND_MIGRATION_CHECKSUM_SET_MISMATCH",
    "BACKEND_REPOSITORY_CATALOG_MISMATCH",
    "BACKEND_RESET_POLICY_MISMATCH",
    "BACKEND_RENDER_PROBE_NOT_QUIESCED",
  ]);
  assert.equal(report.status, "blocked");
  assert.equal(report.authorityGranted, false);
  assert.equal(report.mutationsPerformed, false);
});

test("release-candidate preflight validates provider evidence if a future candidate selects live probe mode", () => {
  const cases = [
    {
      manifest: { tracked: false },
      blocker: "BACKEND_PROBE_MANIFEST_NOT_TRACKED",
    },
    {
      manifest: { valid: false, manifestSha256: null },
      blocker: "BACKEND_PROBE_MANIFEST_INVALID",
    },
    {
      manifest: { configuredNhlSeasonKey: "20252026" },
      blocker: "BACKEND_PROBE_MANIFEST_SEASON_MISMATCH",
    },
  ];
  for (const { manifest, blocker } of cases) {
    const report = evaluateReleaseCandidatePreflight({
      frontend: repository("frontend"),
      backend: repository("backend", {
        releaseFacts: backendReleaseFacts({
          probeManifest: {
            exists: true,
            tracked: true,
            valid: true,
            manifestSha256: MANIFEST_HASH,
            configuredNhlSeasonKey:
              EXPECTED_CONFIGURED_NHL_SEASON_KEY,
            probeNhlSeasonKey: EXPECTED_PROBE_NHL_SEASON_KEY,
            ...manifest,
          },
          renderProbe: {
            liveMode: "probe",
            safe: false,
          },
        }),
      }),
      candidate: {
        releaseId: "HL-20260722-1",
        frontendCommit: FRONTEND_COMMIT,
        backendCommit: BACKEND_COMMIT,
      },
      nodeVersion: EXPECTED_NODE_VERSION,
    });
    assert.deepEqual(report.blockers, [
      blocker,
      "BACKEND_RENDER_PROBE_NOT_QUIESCED",
    ]);
    assert.equal(report.status, "blocked");
  }
});

test("release-candidate preflight rejects every final Blueprint transition drift", () => {
  for (const renderProbe of [
    { nodeMode: "development", safe: false },
    { maintenanceHold: "true", safe: false },
    { debugRoutesEnabled: "true", safe: false },
    { backupScheduleEnabled: "true", safe: false },
  ]) {
    const report = evaluateReleaseCandidatePreflight({
      frontend: repository("frontend"),
      backend: repository("backend", {
        releaseFacts: backendReleaseFacts({ renderProbe }),
      }),
      candidate: {
        releaseId: "HL-20260722-1",
        frontendCommit: FRONTEND_COMMIT,
        backendCommit: BACKEND_COMMIT,
      },
      nodeVersion: EXPECTED_NODE_VERSION,
    });

    assert.deepEqual(report.blockers, [
      "BACKEND_RENDER_PROBE_NOT_QUIESCED",
    ]);
    assert.equal(report.status, "blocked");
  }
});

test("release-candidate preflight rejects every forbidden live-provider Blueprint input while mode is disabled", (t) => {
  const forbiddenFields = [
    "SPORTSDATAIO_NHL_LIVE_API_KEY",
    "SPORTSDATAIO_NHL_LIVE_API_ORIGIN",
    "SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET",
    "SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION",
    "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT",
    "SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST",
  ];
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-release-provider-input-")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const safeEnvironment = [
    ["NODE_ENV", "production"],
    ["STAGING_MAINTENANCE_HOLD", "false"],
    ["SPORTSDATAIO_NHL_LIVE_MODE", "disabled"],
    ["LEAGUE_WRITE_MODE", "closed"],
    ["SCHEDULED_JOBS_ENABLED", "false"],
    ["FREE_AGENT_DRAFT_ROUTES_ENABLED", "false"],
    ["ACCOUNT_EMAIL_DELIVERY_ENABLED", "false"],
    ["DEBUG_ROUTES_ENABLED", "false"],
    ["EMAIL_DELIVERY_MODE", "capture"],
    ["BACKUP_SCHEDULE_ENABLED", "false"],
  ].map(([key, value]) => ({ key, value }));

  for (const field of forbiddenFields) {
    fs.writeFileSync(
      path.join(root, "render.yaml"),
      JSON.stringify({
        services: [{
          envVars: [
            ...safeEnvironment,
            { key: field, value: "configured" },
          ],
        }],
      })
    );
    const inspected = inspectBackendReleaseFacts({
      directory: root,
      runGit: () => "",
    }).renderProbe;
    assert.deepEqual(inspected.forbiddenLiveProviderInputs, [field]);
    assert.equal(inspected.safe, false);

    const report = evaluateReleaseCandidatePreflight({
      frontend: repository("frontend"),
      backend: repository("backend", {
        releaseFacts: backendReleaseFacts({ renderProbe: inspected }),
      }),
      candidate: {
        releaseId: "HL-20260722-1",
        frontendCommit: FRONTEND_COMMIT,
        backendCommit: BACKEND_COMMIT,
      },
      nodeVersion: EXPECTED_NODE_VERSION,
    });
    assert.deepEqual(
      report.blockers,
      ["BACKEND_RENDER_PROBE_NOT_QUIESCED"],
      field
    );
  }
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

test("backend release-source inspection proves schema 22 through 49 and the provider-disabled Blueprint", () => {
  const facts = inspectBackendReleaseFacts({
    directory: path.resolve(__dirname, "..", ".."),
  });
  assert.deepEqual(facts.migrationSource, {
    baseSchemaVersion: EXPECTED_BASE_SCHEMA_VERSION,
    targetSchemaVersion: EXPECTED_SCHEMA_VERSION,
    migrationCount: EXPECTED_MIGRATION_COUNT,
    postBaseMigrationCount: EXPECTED_POST_BASE_MIGRATION_COUNT,
    contiguous: true,
    checksumSetSha256:
      EXPECTED_MIGRATION_CHECKSUM_SET_SHA256,
  });
  assert.deepEqual(facts.repositorySource, {
    repositoryCatalogCount:
      EXPECTED_REPOSITORY_CATALOG_COUNT,
    repositoryCatalogSha256:
      EXPECTED_REPOSITORY_CATALOG_SHA256,
    postResetRequireEmptyCount:
      EXPECTED_POST_RESET_REQUIRE_EMPTY_COUNT,
    postResetPolicySha256:
      EXPECTED_POST_RESET_POLICY_SHA256,
    resetPolicyCoverageValid: true,
  });
  assert.equal(facts.renderProbe.safe, true);
  assert.equal(facts.renderProbe.nodeMode, "production");
  assert.equal(facts.renderProbe.maintenanceHold, "false");
  assert.equal(facts.renderProbe.leagueWriteMode, "closed");
  assert.equal(facts.renderProbe.accountEmailDeliveryEnabled, "false");
  assert.equal(facts.renderProbe.debugRoutesEnabled, "false");
  assert.equal(facts.renderProbe.backupScheduleEnabled, "false");
  assert.deepEqual(facts.renderProbe.forbiddenEmailInputs, []);
  assert.deepEqual(facts.renderProbe.forbiddenLiveProviderInputs, []);
  if (facts.probeManifest.exists) {
    assert.equal(facts.probeManifest.tracked, true);
    assert.equal(facts.probeManifest.valid, true);
    assert.equal(
      facts.probeManifest.configuredNhlSeasonKey,
      EXPECTED_CONFIGURED_NHL_SEASON_KEY
    );
    assert.equal(
      facts.probeManifest.probeNhlSeasonKey,
      EXPECTED_PROBE_NHL_SEASON_KEY
    );
  } else {
    assert.equal(facts.probeManifest.valid, false);
    assert.equal(facts.probeManifest.manifestSha256, null);
  }
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
