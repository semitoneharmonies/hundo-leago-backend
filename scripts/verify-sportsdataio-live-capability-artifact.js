#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const {
  createSecurityFoundations,
} = require("../src/bootstrap/createSecurityFoundations");
const {
  verifyRequiredSportsDataIoLiveCapability,
} = require("../src/bootstrap/openDeployedTargetRuntime");
const {
  loadTargetRuntimeConfig,
} = require("../src/config/loadTargetRuntimeConfig");

const BACKEND_ROOT = path.resolve(__dirname, "..");
const SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES =
  Object.freeze({
    argumentInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_VERIFY_COMMAND_ARGUMENT_INVALID",
    configurationInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_VERIFY_COMMAND_CONFIGURATION_INVALID",
    verificationFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_VERIFY_COMMAND_VERIFICATION_FAILED",
    internalFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_VERIFY_COMMAND_INTERNAL_FAILED",
  });
const SAFE_ERROR_CODES = new Set(
  Object.values(
    SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
  )
);
const UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_RDWR |
  fs.constants.O_APPEND |
  fs.constants.O_CREAT |
  fs.constants.O_TRUNC |
  fs.constants.O_EXCL;

class SportsDataIoLiveCapabilityVerifyCommandError extends Error {
  constructor(code) {
    super(
      "The SportsDataIO live capability verification command failed safely."
    );
    this.name =
      "SportsDataIoLiveCapabilityVerifyCommandError";
    this.code = code;
  }
}

function fail(code) {
  throw new SportsDataIoLiveCapabilityVerifyCommandError(code);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .argumentInvalid
    );
  }
  return Object.freeze({});
}

function createReadOnlyFsModule(fsModule = fs) {
  if (
    !fsModule ||
    typeof fsModule !== "object" ||
    typeof fsModule.realpathSync?.native !== "function" ||
    typeof fsModule.constants !== "object"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  const invoke = (method, args) => {
    if (typeof fsModule[method] !== "function") {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
          .configurationInvalid
      );
    }
    return Reflect.apply(fsModule[method], fsModule, args);
  };
  const denyWrite = () => fail(
    SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
      .verificationFailed
  );
  const realpathSync = (...args) =>
    invoke("realpathSync", args);
  realpathSync.native = (...args) =>
    Reflect.apply(
      fsModule.realpathSync.native,
      fsModule.realpathSync,
      args
    );
  return Object.freeze({
    constants: fsModule.constants,
    closeSync: (...args) => invoke("closeSync", args),
    fstatSync: (...args) => invoke("fstatSync", args),
    fsyncSync: denyWrite,
    linkSync: denyWrite,
    lstatSync: (...args) => invoke("lstatSync", args),
    mkdirSync: denyWrite,
    openSync(filePath, flags, ...args) {
      if (
        !Number.isInteger(flags) ||
        (flags & WRITE_FLAGS) !== 0
      ) {
        denyWrite();
      }
      return invoke("openSync", [filePath, flags, ...args]);
    },
    readFileSync: (...args) => invoke("readFileSync", args),
    readSync: (...args) => invoke("readSync", args),
    realpathSync,
    renameSync: denyWrite,
    unlinkSync: denyWrite,
    writeFileSync: denyWrite,
  });
}

function readConfiguration(env) {
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    env.NODE_ENV !== "production" ||
    env.STAGING_MAINTENANCE_HOLD !== "false" ||
    env.BACKUP_SCHEDULE_ENABLED !== "false"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  let config;
  try {
    config = loadTargetRuntimeConfig({
      env,
      backendRoot: BACKEND_ROOT,
    });
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  if (
    config.appEnv !== "staging" ||
    config?.sportsDataIoLiveNhl?.mode !== "required" ||
    config.leagueWriteMode !== "closed" ||
    config.scheduledJobsEnabled !== false ||
    config.freeAgentDraftRoutesEnabled !== false ||
    config.accountEmailDeliveryEnabled !== false ||
    config.debugRoutesEnabled !== false ||
    config.security?.email?.deliveryMode !== "capture"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  return config;
}

function sanitizeVerificationReceipt(descriptor, config) {
  const verification = descriptor?.verification;
  if (
    descriptor?.mode !== "required" ||
    descriptor.enabled !== true ||
    descriptor.verified !== true ||
    descriptor.origin !== config.sportsDataIoLiveNhl.origin ||
    descriptor.nhlSeasonKey !==
      config.currentSeason.nhlSeasonKey ||
    descriptor.capabilityKeyVersion !==
      config.sportsDataIoLiveNhl.capabilityKeyVersion ||
    typeof descriptor.probeNhlSeasonKey !== "string" ||
    typeof descriptor.probeKind !== "string" ||
    !SHA256_PATTERN.test(descriptor.probeManifestSha256) ||
    verification?.status !== "verified" ||
    !UUID_V4_PATTERN.test(verification.evidenceId) ||
    !SHA256_PATTERN.test(verification.evidenceSha256) ||
    !Number.isSafeInteger(verification.issuedAtMs) ||
    !Number.isSafeInteger(verification.expiresAtMs) ||
    !Number.isSafeInteger(verification.verifiedAtMs) ||
    verification.issuedAtMs < 0 ||
    verification.expiresAtMs <= verification.issuedAtMs ||
    verification.verifiedAtMs < verification.issuedAtMs ||
    verification.verifiedAtMs >= verification.expiresAtMs
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .internalFailed
    );
  }
  return Object.freeze({
    status: "verified",
    appEnv: config.appEnv,
    environmentId: config.environmentId,
    backendBuildId: config.buildId,
    origin: descriptor.origin,
    configuredNhlSeasonKey: descriptor.nhlSeasonKey,
    capabilityKeyVersion: descriptor.capabilityKeyVersion,
    probeNhlSeasonKey: descriptor.probeNhlSeasonKey,
    probeKind: descriptor.probeKind,
    probeManifestSha256: descriptor.probeManifestSha256,
    evidenceId: verification.evidenceId,
    evidenceSha256: verification.evidenceSha256,
    issuedAtMs: verification.issuedAtMs,
    expiresAtMs: verification.expiresAtMs,
    verifiedAtMs: verification.verifiedAtMs,
  });
}

function runSportsDataIoLiveCapabilityArtifactVerifyCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
  fsModule = fs,
  now = Date.now,
} = {}) {
  if (
    !output ||
    typeof output.log !== "function" ||
    typeof now !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  parseArguments(argv);
  const config = readConfiguration(env);
  let securityFoundations;
  try {
    securityFoundations = createSecurityFoundations({
      env,
      loadConfig: () => config.security,
      loggerSink() {},
      now,
    });
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  let descriptor;
  try {
    descriptor = verifyRequiredSportsDataIoLiveCapability({
      config,
      securityFoundations,
      fsModule: createReadOnlyFsModule(fsModule),
    });
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
        .verificationFailed
    );
  }
  const receipt = sanitizeVerificationReceipt(
    descriptor,
    config
  );
  output.log(JSON.stringify(receipt));
  return receipt;
}

function main({
  command = runSportsDataIoLiveCapabilityArtifactVerifyCommand,
  output = console,
  processObject = process,
} = {}) {
  try {
    const receipt = command({ output });
    processObject.exitCode =
      receipt?.status === "verified" ? 0 : 1;
    return receipt;
  } catch (error) {
    processObject.exitCode = 1;
    const code = SAFE_ERROR_CODES.has(error?.code)
      ? error.code
      : SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES
          .internalFailed;
    output.error(JSON.stringify({
      error: {
        code,
        message:
          "The SportsDataIO live capability verification command failed safely.",
      },
    }));
    return null;
  }
}

if (require.main === module) main();

module.exports = {
  SPORTS_DATA_IO_LIVE_CAPABILITY_VERIFY_COMMAND_ERROR_CODES,
  SportsDataIoLiveCapabilityVerifyCommandError,
  createReadOnlyFsModule,
  main,
  parseArguments,
  readConfiguration,
  runSportsDataIoLiveCapabilityArtifactVerifyCommand,
  sanitizeVerificationReceipt,
};
