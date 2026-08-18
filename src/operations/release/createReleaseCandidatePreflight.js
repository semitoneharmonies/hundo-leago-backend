const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  canonicalize,
} = require("./releaseQaFixtureContract");
const {
  discoverMigrations,
} = require("../../infrastructure/database/migrate");
const {
  RESET_V1_POST_RESET_TABLE_POLICY,
  assertPolicyCatalogCoverage,
} = require("../../infrastructure/migration/resetManifest");
const {
  REPOSITORY_CATALOG,
} = require(
  "../../infrastructure/persistence/sqlite/repositoryCatalog"
);
const {
  SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST_RELATIVE_PATH,
} = require("../../config/loadTargetRuntimeConfig");
const {
  loadSportsDataIoLiveProbeManifest,
} = require("../../bootstrap/openDeployedTargetRuntime");

const EXPECTED_NODE_VERSION = "v24.14.1";
const EXPECTED_STAGING_BRANCH = "staging";
const EXPECTED_BASE_SCHEMA_VERSION = 22;
const EXPECTED_SCHEMA_VERSION = 52;
const EXPECTED_MIGRATION_COUNT = 52;
const EXPECTED_POST_BASE_MIGRATION_COUNT = 30;
const EXPECTED_MIGRATION_CHECKSUM_SET_SHA256 =
  "1979cc016fc1102e0f970940e7b6551a73644b7b94bacbe511202c7ac1111546";
const EXPECTED_REPOSITORY_CATALOG_COUNT = 132;
const EXPECTED_REPOSITORY_CATALOG_SHA256 =
  "7e3fad751377473e0e480632eede509398a388c3176e54df748586b390384914";
const EXPECTED_POST_RESET_REQUIRE_EMPTY_COUNT = 50;
const EXPECTED_POST_RESET_POLICY_SHA256 =
  "56efc1e7285475243310657fe1d32b3016a655bf12c6fb7a9150db89f26ed59e";
const EXPECTED_CONFIGURED_NHL_SEASON_KEY = "20262027";
const EXPECTED_PROBE_NHL_SEASON_KEY = "20252026";
const EXPECTED_PROBE_MANIFEST_RELATIVE_PATH =
  SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST_RELATIVE_PATH.replaceAll(
    "\\",
    "/"
  );
const RELEASE_ID_PATTERN = /^HL-\d{8}-[1-9]\d*$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEASON_KEY_PATTERN = /^\d{8}$/;

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

function exactRenderEnvironment(directory) {
  try {
    const blueprint = JSON.parse(
      fs.readFileSync(path.join(directory, "render.yaml"), "utf8")
    );
    if (
      !blueprint || !Array.isArray(blueprint.services) ||
      blueprint.services.length !== 1 ||
      !Array.isArray(blueprint.services[0]?.envVars)
    ) {
      return null;
    }
    return new Map(
      blueprint.services[0].envVars.map((entry) => [entry?.key, entry])
    );
  } catch {
    return null;
  }
}

function inspectRenderProbeSafety(directory) {
  const environment = exactRenderEnvironment(directory);
  const value = (key) => environment?.get(key)?.value ?? null;
  const forbiddenEmailInputs = [
    "EMAIL_FROM",
    "EMAIL_REPLY_TO",
    "RESEND_API_KEY",
    "STAGING_EMAIL_RECIPIENT_ALLOWLIST",
  ].filter((key) => environment?.has(key));
  const forbiddenLiveProviderInputs = [
    "SPORTSDATAIO_NHL_LIVE_API_KEY",
    "SPORTSDATAIO_NHL_LIVE_API_ORIGIN",
    "SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET",
    "SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION",
    "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT",
    "SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST",
  ].filter((key) => environment?.has(key));
  const facts = {
    nodeMode: value("NODE_ENV"),
    maintenanceHold: value("STAGING_MAINTENANCE_HOLD"),
    liveMode: value("SPORTSDATAIO_NHL_LIVE_MODE"),
    leagueWriteMode: value("LEAGUE_WRITE_MODE"),
    scheduledJobsEnabled: value("SCHEDULED_JOBS_ENABLED"),
    freeAgentDraftRoutesEnabled:
      value("FREE_AGENT_DRAFT_ROUTES_ENABLED"),
    accountEmailDeliveryEnabled:
      value("ACCOUNT_EMAIL_DELIVERY_ENABLED"),
    debugRoutesEnabled: value("DEBUG_ROUTES_ENABLED"),
    emailDeliveryMode: value("EMAIL_DELIVERY_MODE"),
    backupScheduleEnabled: value("BACKUP_SCHEDULE_ENABLED"),
    forbiddenEmailInputs,
    forbiddenLiveProviderInputs,
  };
  return Object.freeze({
    ...facts,
    safe:
      facts.nodeMode === "production" &&
      facts.maintenanceHold === "false" &&
      facts.liveMode === "disabled" &&
      facts.leagueWriteMode === "closed" &&
      facts.scheduledJobsEnabled === "false" &&
      facts.freeAgentDraftRoutesEnabled === "false" &&
      facts.accountEmailDeliveryEnabled === "false" &&
      facts.debugRoutesEnabled === "false" &&
      facts.emailDeliveryMode === "capture" &&
      facts.backupScheduleEnabled === "false" &&
      forbiddenEmailInputs.length === 0 &&
      forbiddenLiveProviderInputs.length === 0,
  });
}

function inspectProbeManifest({ directory, runGit }) {
  const relativePath =
    SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST_RELATIVE_PATH;
  const manifestPath = path.join(directory, relativePath);
  const exists =
    fs.existsSync(manifestPath) && fs.lstatSync(manifestPath).isFile();
  const tracked = runGit(
    directory,
    ["ls-files", "--stage", "--", relativePath.replaceAll("\\", "/")]
  ) !== "";
  let valid = false;
  let manifestSha256 = null;
  let configuredNhlSeasonKey = null;
  let probeNhlSeasonKey = null;
  if (exists) {
    try {
      const loaded = loadSportsDataIoLiveProbeManifest({
        manifestPath,
      });
      valid = true;
      manifestSha256 = loaded.probeManifestSha256;
      configuredNhlSeasonKey =
        loaded.manifest.configuredNhlSeasonKey;
      probeNhlSeasonKey = loaded.manifest.probeNhlSeasonKey;
    } catch {
      // The release report records only safe validity facts.
    }
  }
  return Object.freeze({
    relativePath: relativePath.replaceAll("\\", "/"),
    exists,
    tracked,
    valid,
    manifestSha256,
    configuredNhlSeasonKey,
    probeNhlSeasonKey,
  });
}

function inspectMigrationSource(directory) {
  try {
    const migrations = discoverMigrations({
      migrationsDirectory: path.join(directory, "database", "migrations"),
    });
    const identities = migrations.map(({ id, fileName, checksum }) => ({
      id,
      fileName,
      checksum,
    }));
    const contiguous = identities.every(
      ({ id }, index) => id === index + 1
    );
    return Object.freeze({
      baseSchemaVersion: EXPECTED_BASE_SCHEMA_VERSION,
      targetSchemaVersion: identities.at(-1)?.id ?? null,
      migrationCount: identities.length,
      postBaseMigrationCount: identities.filter(
        ({ id }) => id > EXPECTED_BASE_SCHEMA_VERSION
      ).length,
      contiguous,
      checksumSetSha256: sha256(canonicalize(identities)),
    });
  } catch {
    return Object.freeze({
      baseSchemaVersion: EXPECTED_BASE_SCHEMA_VERSION,
      targetSchemaVersion: null,
      migrationCount: 0,
      postBaseMigrationCount: 0,
      contiguous: false,
      checksumSetSha256: null,
    });
  }
}

function inspectResetAndRepositorySource() {
  let resetPolicyCoverageValid = false;
  try {
    resetPolicyCoverageValid = assertPolicyCatalogCoverage() === true;
  } catch {
    // The release report records only safe validity facts.
  }
  return Object.freeze({
    repositoryCatalogCount: REPOSITORY_CATALOG.length,
    repositoryCatalogSha256:
      sha256(canonicalize(REPOSITORY_CATALOG)),
    postResetRequireEmptyCount:
      RESET_V1_POST_RESET_TABLE_POLICY.length,
    postResetPolicySha256:
      sha256(canonicalize(RESET_V1_POST_RESET_TABLE_POLICY)),
    resetPolicyCoverageValid,
  });
}

function inspectBackendReleaseFacts({ directory, runGit = readGit } = {}) {
  if (!path.isAbsolute(directory || "") || typeof runGit !== "function") {
    fail(
      "RELEASE_CANDIDATE_INPUT_INVALID",
      "Exact backend release-source inspection input is required."
    );
  }
  const physicalDirectory = fs.realpathSync(directory);
  return Object.freeze({
    migrationSource: inspectMigrationSource(physicalDirectory),
    repositorySource: inspectResetAndRepositorySource(),
    probeManifest: inspectProbeManifest({
      directory: physicalDirectory,
      runGit,
    }),
    renderProbe: inspectRenderProbeSafety(physicalDirectory),
  });
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

function assertBackendReleaseFacts(facts) {
  const migration = facts?.migrationSource;
  const repository = facts?.repositorySource;
  const manifest = facts?.probeManifest;
  const render = facts?.renderProbe;
  if (
    !facts || typeof facts !== "object" || Array.isArray(facts) ||
    !migration || !repository || !manifest || !render ||
    !Number.isSafeInteger(migration.baseSchemaVersion) ||
    !Number.isSafeInteger(migration.migrationCount) ||
    !Number.isSafeInteger(migration.postBaseMigrationCount) ||
    !(
      migration.targetSchemaVersion === null ||
      (
        Number.isSafeInteger(migration.targetSchemaVersion) &&
        migration.targetSchemaVersion > 0
      )
    ) ||
    typeof migration.contiguous !== "boolean" ||
    !(
      migration.checksumSetSha256 === null ||
      SHA256_PATTERN.test(migration.checksumSetSha256)
    ) ||
    !Number.isSafeInteger(repository.repositoryCatalogCount) ||
    !SHA256_PATTERN.test(repository.repositoryCatalogSha256 || "") ||
    !Number.isSafeInteger(repository.postResetRequireEmptyCount) ||
    !SHA256_PATTERN.test(repository.postResetPolicySha256 || "") ||
    typeof repository.resetPolicyCoverageValid !== "boolean" ||
    typeof manifest.relativePath !== "string" ||
    typeof manifest.exists !== "boolean" ||
    typeof manifest.tracked !== "boolean" ||
    typeof manifest.valid !== "boolean" ||
    !(
      manifest.manifestSha256 === null ||
      SHA256_PATTERN.test(manifest.manifestSha256)
    ) ||
    !(
      manifest.configuredNhlSeasonKey === null ||
      SEASON_KEY_PATTERN.test(manifest.configuredNhlSeasonKey)
    ) ||
    !(
      manifest.probeNhlSeasonKey === null ||
      SEASON_KEY_PATTERN.test(manifest.probeNhlSeasonKey)
    ) ||
    typeof render.safe !== "boolean" ||
    !Array.isArray(render.forbiddenEmailInputs) ||
    render.forbiddenEmailInputs.some(
      (value) => typeof value !== "string" || value === ""
    ) ||
    !Array.isArray(render.forbiddenLiveProviderInputs) ||
    render.forbiddenLiveProviderInputs.some(
      (value) => typeof value !== "string" || value === ""
    ) ||
    [
      render.nodeMode,
      render.maintenanceHold,
      render.liveMode,
      render.leagueWriteMode,
      render.scheduledJobsEnabled,
      render.freeAgentDraftRoutesEnabled,
      render.accountEmailDeliveryEnabled,
      render.debugRoutesEnabled,
      render.emailDeliveryMode,
      render.backupScheduleEnabled,
    ].some((value) => value !== null && typeof value !== "string")
  ) {
    fail(
      "RELEASE_CANDIDATE_FACTS_INVALID",
      "Exact backend release-source facts are required."
    );
  }
}

function renderProbeIsSafe(render) {
  return (
    render.safe === true &&
    render.nodeMode === "production" &&
    render.maintenanceHold === "false" &&
    render.liveMode === "disabled" &&
    render.leagueWriteMode === "closed" &&
    render.scheduledJobsEnabled === "false" &&
    render.freeAgentDraftRoutesEnabled === "false" &&
    render.accountEmailDeliveryEnabled === "false" &&
    render.debugRoutesEnabled === "false" &&
    render.emailDeliveryMode === "capture" &&
    render.backupScheduleEnabled === "false" &&
    render.forbiddenEmailInputs.length === 0 &&
    render.forbiddenLiveProviderInputs.length === 0
  );
}

function backendReleaseBlockers(facts) {
  const blockers = [];
  const migration = facts.migrationSource;
  const repository = facts.repositorySource;
  const manifest = facts.probeManifest;
  if (
    migration.baseSchemaVersion !== EXPECTED_BASE_SCHEMA_VERSION ||
    migration.targetSchemaVersion !== EXPECTED_SCHEMA_VERSION
  ) {
    blockers.push("BACKEND_SCHEMA_TARGET_MISMATCH");
  }
  if (
    migration.migrationCount !== EXPECTED_MIGRATION_COUNT ||
    migration.postBaseMigrationCount !==
      EXPECTED_POST_BASE_MIGRATION_COUNT ||
    migration.contiguous !== true
  ) {
    blockers.push("BACKEND_MIGRATION_SEQUENCE_INVALID");
  }
  if (
    migration.checksumSetSha256 !==
      EXPECTED_MIGRATION_CHECKSUM_SET_SHA256
  ) {
    blockers.push("BACKEND_MIGRATION_CHECKSUM_SET_MISMATCH");
  }
  if (
    repository.repositoryCatalogCount !==
      EXPECTED_REPOSITORY_CATALOG_COUNT ||
    repository.repositoryCatalogSha256 !==
      EXPECTED_REPOSITORY_CATALOG_SHA256
  ) {
    blockers.push("BACKEND_REPOSITORY_CATALOG_MISMATCH");
  }
  if (
    repository.postResetRequireEmptyCount !==
      EXPECTED_POST_RESET_REQUIRE_EMPTY_COUNT ||
    repository.postResetPolicySha256 !==
      EXPECTED_POST_RESET_POLICY_SHA256 ||
    repository.resetPolicyCoverageValid !== true
  ) {
    blockers.push("BACKEND_RESET_POLICY_MISMATCH");
  }
  if (facts.renderProbe.liveMode !== "disabled") {
    if (!manifest.exists) {
      blockers.push("BACKEND_PROBE_MANIFEST_MISSING");
    } else {
      if (!manifest.tracked) {
        blockers.push("BACKEND_PROBE_MANIFEST_NOT_TRACKED");
      }
      if (
        !manifest.valid ||
        manifest.relativePath !==
          EXPECTED_PROBE_MANIFEST_RELATIVE_PATH ||
        !SHA256_PATTERN.test(manifest.manifestSha256 || "")
      ) {
        blockers.push("BACKEND_PROBE_MANIFEST_INVALID");
      } else if (
        manifest.configuredNhlSeasonKey !==
          EXPECTED_CONFIGURED_NHL_SEASON_KEY ||
        manifest.probeNhlSeasonKey !== EXPECTED_PROBE_NHL_SEASON_KEY
      ) {
        blockers.push("BACKEND_PROBE_MANIFEST_SEASON_MISMATCH");
      }
    }
  }
  if (!renderProbeIsSafe(facts.renderProbe)) {
    blockers.push("BACKEND_RENDER_PROBE_NOT_QUIESCED");
  }
  return blockers;
}

function evaluateReleaseCandidatePreflight({
  backend,
  candidate = null,
  frontend,
  nodeVersion,
} = {}) {
  assertRepositoryFacts(backend, "backend");
  assertRepositoryFacts(frontend, "frontend");
  assertBackendReleaseFacts(backend.releaseFacts);
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
  blockers.push(...backendReleaseBlockers(backend.releaseFacts));
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
      releaseFacts: backend.releaseFacts,
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
  const backendWithReleaseFacts = Object.freeze({
    ...backend,
    releaseFacts: inspectBackendReleaseFacts({
      directory: backendDirectory,
      runGit,
    }),
  });
  const frontend = inspectRepository({
    name: "frontend",
    directory: frontendDirectory,
    configurationFiles: ["package-lock.json", "package.json", "vite.config.js"],
    runGit,
  });
  return evaluateReleaseCandidatePreflight({
    backend: backendWithReleaseFacts,
    candidate,
    frontend,
    nodeVersion,
  });
}

module.exports = {
  COMMIT_PATTERN,
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
  EXPECTED_STAGING_BRANCH,
  RELEASE_ID_PATTERN,
  ReleaseCandidatePreflightError,
  createReleaseCandidatePreflight,
  evaluateReleaseCandidatePreflight,
  inspectBackendReleaseFacts,
  inspectRepository,
};
