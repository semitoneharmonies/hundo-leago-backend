#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES,
  createSportsDataIoLiveCapabilityCheck,
} = require(
  "../src/operations/statistics/createSportsDataIoLiveCapabilityCheck"
);
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS,
} = require(
  "../src/domain/statistics/sportsDataIoLiveCapabilityEvidencePolicy"
);
const {
  resolveSportsDataIoLiveProbeManifestPath,
} = require("../src/config/loadTargetRuntimeConfig");

const BACKEND_ROOT = path.resolve(__dirname, "..");
const CANONICAL_PROBE_MANIFEST_PATH =
  resolveSportsDataIoLiveProbeManifestPath(BACKEND_ROOT);

const SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES =
  Object.freeze({
    argumentInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_COMMAND_ARGUMENT_INVALID",
    configurationInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_COMMAND_CONFIGURATION_INVALID",
    internalFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_COMMAND_INTERNAL_FAILED",
  });
const SUCCESS_STATUSES = new Set([
  "passed",
  "published",
  "replaced",
  "replayed",
]);
const PROVIDER_FAILURE_CODES = new Set([
  SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
    .providerFailed,
  SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
    .semanticFailed,
]);
const SAFE_ERROR_CODES = new Set([
  ...Object.values(
    SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
  ),
  ...Object.values(
    SPORTS_DATA_IO_LIVE_CAPABILITY_CHECK_ERROR_CODES
  ),
]);
const MAX_MANIFEST_BYTES = 512 * 1024;
const RECEIPT_KEYS = Object.freeze([
  "status",
  "capabilityStatus",
  "evidenceId",
  "evidenceSha256",
  "appEnv",
  "environmentId",
  "backendBuildId",
  "issuedAtMs",
  "expiresAtMs",
  "sourceVersion",
  "assertions",
]);
const UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_VERSION_PATTERN =
  /^sportsdataio-live-sha256-[a-f0-9]{64}$/u;
const VALIDITY_MS = 86_400_000;

class SportsDataIoLiveCapabilityCommandError extends Error {
  constructor(code) {
    super("The SportsDataIO live capability command failed safely.");
    this.name = "SportsDataIoLiveCapabilityCommandError";
    this.code = code;
  }
}

function fail(code) {
  throw new SportsDataIoLiveCapabilityCommandError(code);
}

function parseArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 0
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .argumentInvalid
    );
  }
  return Object.freeze({});
}

function requiredText(env, field, maximum = 4096) {
  const value = env[field];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  return value;
}

function normalizedAbsolutePath(env, field) {
  const value = requiredText(env, field);
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  return value;
}

function readConfiguration(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  if (
    requiredText(env, "APP_ENV", 64) !== "staging" ||
    requiredText(env, "NODE_ENV", 16) !== "production" ||
    requiredText(
      env,
      "SPORTSDATAIO_NHL_LIVE_MODE",
      16
    ) !== "probe" ||
    requiredText(env, "STAGING_MAINTENANCE_HOLD", 5) !== "false" ||
    requiredText(env, "LEAGUE_WRITE_MODE", 16) !== "closed" ||
    requiredText(env, "SCHEDULED_JOBS_ENABLED", 5) !== "false" ||
    requiredText(env, "FREE_AGENT_DRAFT_ROUTES_ENABLED", 5) !== "false" ||
    requiredText(env, "ACCOUNT_EMAIL_DELIVERY_ENABLED", 5) !== "false" ||
    requiredText(env, "DEBUG_ROUTES_ENABLED", 5) !== "false" ||
    requiredText(env, "EMAIL_DELIVERY_MODE", 16) !== "capture" ||
    requiredText(env, "BACKUP_SCHEDULE_ENABLED", 5) !== "false"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  const capabilityKeyVersionText = requiredText(
    env,
    "SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION",
    16
  );
  if (!/^[1-9]\d*$/u.test(capabilityKeyVersionText)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  const capabilityKeyVersion = Number(
    capabilityKeyVersionText
  );
  if (!Number.isSafeInteger(capabilityKeyVersion)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  const persistentRoot = normalizedAbsolutePath(
    env,
    "PERSISTENT_DATA_ROOT"
  );
  const artifactPath = normalizedAbsolutePath(
    env,
    "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT"
  );
  const relativeArtifactPath = path.relative(
    persistentRoot,
    artifactPath
  );
  if (
    relativeArtifactPath === "" ||
    relativeArtifactPath === ".." ||
    relativeArtifactPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeArtifactPath)
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  const configuration = {
    appEnv: "staging",
    environmentId: requiredText(
      env,
      "APP_ENVIRONMENT_ID",
      200
    ),
    backendBuildId: requiredText(env, "APP_BUILD_ID", 200),
    configuredNhlSeasonKey: requiredText(
      env,
      "CURRENT_NHL_SEASON_KEY",
      8
    ),
    dedicatedLiveApiKey: requiredText(
      env,
      "SPORTSDATAIO_NHL_LIVE_API_KEY",
      1024
    ),
    capabilitySecret: requiredText(
      env,
      "SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET",
      4096
    ),
    capabilityKeyVersion,
    persistentRoot,
    artifactPath,
  };
  if (
    env.SPORTSDATAIO_NHL_LIVE_API_ORIGIN !== undefined
  ) {
    configuration.origin = requiredText(
      env,
      "SPORTSDATAIO_NHL_LIVE_API_ORIGIN",
      200
    );
  }
  return Object.freeze(configuration);
}

function readProbeManifest(filePath, readFileSync = fs.readFileSync) {
  let raw;
  try {
    raw = readFileSync(filePath);
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  if (
    !Buffer.isBuffer(raw) ||
    raw.length < 1 ||
    raw.length > MAX_MANIFEST_BYTES
  ) {
    if (Buffer.isBuffer(raw)) raw.fill(0);
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  } finally {
    raw.fill(0);
  }
}

function normalizeSuccessReceipt(receipt, configuration) {
  const invalid = () => fail(
    SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
      .internalFailed
  );
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.getPrototypeOf(receipt) !== Object.prototype ||
    Object.getOwnPropertySymbols(receipt).length !== 0
  ) {
    invalid();
  }
  const keys = Object.getOwnPropertyNames(receipt).sort();
  const expected = [...RECEIPT_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(receipt, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      invalid();
    }
  }
  if (
    !SUCCESS_STATUSES.has(receipt.status) ||
    receipt.capabilityStatus !== "passed" ||
    !UUID_V4_PATTERN.test(receipt.evidenceId) ||
    !SHA256_PATTERN.test(receipt.evidenceSha256) ||
    receipt.appEnv !== configuration.appEnv ||
    receipt.environmentId !== configuration.environmentId ||
    receipt.backendBuildId !== configuration.backendBuildId ||
    !Number.isSafeInteger(receipt.issuedAtMs) ||
    receipt.issuedAtMs < 0 ||
    !Number.isSafeInteger(receipt.expiresAtMs) ||
    receipt.expiresAtMs - receipt.issuedAtMs !== VALIDITY_MS ||
    !SOURCE_VERSION_PATTERN.test(receipt.sourceVersion) ||
    !Array.isArray(receipt.assertions) ||
    receipt.assertions.length !==
      SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS.length ||
    receipt.assertions.some(
      (value, index) =>
        value !==
          SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS[index]
    )
  ) {
    invalid();
  }
  return Object.freeze({
    status: receipt.status,
    capabilityStatus: receipt.capabilityStatus,
    evidenceId: receipt.evidenceId,
    evidenceSha256: receipt.evidenceSha256,
    appEnv: receipt.appEnv,
    environmentId: receipt.environmentId,
    backendBuildId: receipt.backendBuildId,
    issuedAtMs: receipt.issuedAtMs,
    expiresAtMs: receipt.expiresAtMs,
    sourceVersion: receipt.sourceVersion,
    assertions: Object.freeze([...receipt.assertions]),
  });
}

async function runSportsDataIoLiveCapabilityCheckCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
  createCheck = createSportsDataIoLiveCapabilityCheck,
  readFileSync = fs.readFileSync,
  fetchImpl = globalThis.fetch,
  nowMs,
  randomUUID,
} = {}) {
  if (
    !output ||
    typeof output.log !== "function" ||
    typeof createCheck !== "function" ||
    typeof readFileSync !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  parseArguments(argv);
  const configuration = readConfiguration(env);
  const probeManifest = readProbeManifest(
    CANONICAL_PROBE_MANIFEST_PATH,
    readFileSync
  );
  const options = {
    ...configuration,
    probeManifest,
  };
  if (fetchImpl !== undefined) options.fetchImpl = fetchImpl;
  if (nowMs !== undefined) options.nowMs = nowMs;
  if (randomUUID !== undefined) options.randomUUID = randomUUID;
  const check = createCheck(options);
  if (!check || typeof check.run !== "function") {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
        .internalFailed
    );
  }
  const receipt = normalizeSuccessReceipt(
    await check.run(),
    configuration
  );
  output.log(JSON.stringify(receipt));
  return receipt;
}

function exitCodeForError(error) {
  return PROVIDER_FAILURE_CODES.has(error?.code) ? 2 : 1;
}

async function main({
  command = runSportsDataIoLiveCapabilityCheckCommand,
  output = console,
  processObject = process,
} = {}) {
  try {
    const receipt = await command({ output });
    processObject.exitCode = SUCCESS_STATUSES.has(receipt?.status)
      ? 0
      : 1;
    return receipt;
  } catch (error) {
    processObject.exitCode = exitCodeForError(error);
    const code = SAFE_ERROR_CODES.has(error?.code)
      ? error.code
      : SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES
          .internalFailed;
    output.error(JSON.stringify({
      error: {
        code,
        message:
          "The SportsDataIO live capability command failed safely.",
      },
    }));
    return null;
  }
}

if (require.main === module) void main();

module.exports = {
  SPORTS_DATA_IO_LIVE_CAPABILITY_COMMAND_ERROR_CODES,
  SportsDataIoLiveCapabilityCommandError,
  exitCodeForError,
  main,
  normalizeSuccessReceipt,
  parseArguments,
  readConfiguration,
  readProbeManifest,
  runSportsDataIoLiveCapabilityCheckCommand,
};
