#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const {
  serializeCanonicalJsonV1,
} = require(
  "../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  CONFIGURED_NHL_SEASON_KEY,
  PROVIDER_ORIGIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES,
  discoverSportsDataIoLiveCapability,
} = require(
  "../src/operations/statistics/createSportsDataIoLiveCapabilityDiscovery"
);

const SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES =
  Object.freeze({
    argumentInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ARGUMENT_INVALID",
    configurationInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_COMMAND_CONFIGURATION_INVALID",
    databaseInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_COMMAND_DATABASE_INVALID",
    internalFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_DISCOVERY_COMMAND_INTERNAL_FAILED",
  });
const SAFE_ERROR_CODES = new Set([
  ...Object.values(
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
  ),
  ...Object.values(
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
  ),
]);
const PROVIDER_FAILURE_CODES = new Set([
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
    .providerFailed,
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_ERROR_CODES
    .semanticFailed,
]);
const IDENTITY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATABASE_TIMEOUT_MS = 5_000;
const DATABASE_SIDECAR_SUFFIXES = Object.freeze([
  "-journal",
  "-shm",
  "-wal",
]);
const DISCOVERY_SNAPSHOT_PREFIX =
  "hundo-sportsdataio-live-discovery-";
const DISCOVERY_SNAPSHOT_FILE_NAME = "database.sqlite";

class SportsDataIoLiveCapabilityDiscoveryCommandError extends Error {
  constructor(code) {
    super(
      "The SportsDataIO live capability discovery command failed safely."
    );
    this.name =
      "SportsDataIoLiveCapabilityDiscoveryCommandError";
    this.code = code;
  }
}

function fail(code) {
  throw new SportsDataIoLiveCapabilityDiscoveryCommandError(code);
}

function canonicalDate(value) {
  const match =
    typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  if (!match) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .argumentInvalid
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    value < "2025-07-01" ||
    value > "2026-06-30"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .argumentInvalid
    );
  }
  return value;
}

function parseArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--historical-date"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .argumentInvalid
    );
  }
  return Object.freeze({
    historicalDate: canonicalDate(argv[1]),
  });
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
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  return value;
}

function deployedIdentity(env, field) {
  const value = requiredText(env, field, 128);
  if (!IDENTITY_PATTERN.test(value)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  return value;
}

function safeAbsolutePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    path.isAbsolute(value) &&
    path.resolve(value) === path.normalize(value)
  );
}

function isStrictChildPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function existingPathComponents(value) {
  const parsed = path.parse(value);
  const names = value
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((name) => name.length > 0);
  const components = [parsed.root];
  let current = parsed.root;
  for (const name of names) {
    current = path.join(current, name);
    components.push(current);
  }
  return components;
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function sameFileIdentity(left, right) {
  return (
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    (left.ino !== 0 || left.birthtimeMs === right.birthtimeMs) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertDatabaseFileIdentity({
  databasePath,
  expectedIdentity,
  expectedPhysicalPath,
  fsModule = fs,
  errorCode =
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
      .databaseInvalid,
} = {}) {
  let stat;
  let physicalPath;
  try {
    stat = fsModule.lstatSync(databasePath);
    physicalPath = fsModule.realpathSync.native(databasePath);
  } catch {
    fail(errorCode);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    physicalPath !== expectedPhysicalPath ||
    !sameFileIdentity(expectedIdentity, fileIdentity(stat))
  ) {
    fail(errorCode);
  }
  return stat;
}

function validateDatabasePath({
  databasePath,
  persistentRoot,
  fsModule = fs,
} = {}) {
  if (
    !safeAbsolutePath(persistentRoot) ||
    path.parse(persistentRoot).root === persistentRoot ||
    !safeAbsolutePath(databasePath) ||
    !isStrictChildPath(persistentRoot, databasePath) ||
    typeof fsModule.lstatSync !== "function" ||
    typeof fsModule.realpathSync?.native !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  try {
    for (const component of existingPathComponents(databasePath)) {
      if (fsModule.lstatSync(component).isSymbolicLink()) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
            .configurationInvalid
        );
      }
    }
    const rootStat = fsModule.lstatSync(persistentRoot);
    const databaseStat = fsModule.lstatSync(databasePath);
    const physicalRoot = fsModule.realpathSync.native(persistentRoot);
    const physicalDatabase = fsModule.realpathSync.native(databasePath);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !databaseStat.isFile() ||
      databaseStat.isSymbolicLink() ||
      path.relative(persistentRoot, physicalRoot) !== "" ||
      path.relative(databasePath, physicalDatabase) !== "" ||
      !isStrictChildPath(physicalRoot, physicalDatabase)
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
          .configurationInvalid
      );
    }
    return Object.freeze({
      physicalRoot,
      physicalPath: physicalDatabase,
      identity: fileIdentity(databaseStat),
    });
  } catch (error) {
    if (
      error instanceof
        SportsDataIoLiveCapabilityDiscoveryCommandError
    ) {
      throw error;
    }
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
}

function databaseInvalid() {
  fail(
    SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
      .databaseInvalid
  );
}

function assertDatabaseSidecarFree({
  databasePath,
  fsModule = fs,
} = {}) {
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    try {
      fsModule.lstatSync(`${databasePath}${suffix}`);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      databaseInvalid();
    }
    databaseInvalid();
  }
}

function hashGuardedFile({
  filePath,
  expectedIdentity,
  expectedPhysicalPath,
  fsModule = fs,
} = {}) {
  assertDatabaseFileIdentity({
    databasePath: filePath,
    expectedIdentity,
    expectedPhysicalPath,
    fsModule,
  });
  let descriptor;
  let digest;
  let operationFailed = false;
  let closeFailed = false;
  try {
    descriptor = fsModule.openSync(filePath, "r");
    if (
      !sameFileIdentity(
        expectedIdentity,
        fileIdentity(fsModule.fstatSync(descriptor))
      )
    ) {
      operationFailed = true;
    } else {
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let bytesRead;
      do {
        bytesRead = fsModule.readSync(
          descriptor,
          buffer,
          0,
          buffer.length,
          null
        );
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
      digest = hash.digest("hex");
    }
  } catch {
    operationFailed = true;
  } finally {
    if (descriptor !== undefined) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        closeFailed = true;
      }
    }
  }
  if (operationFailed || closeFailed) databaseInvalid();
  assertDatabaseFileIdentity({
    databasePath: filePath,
    expectedIdentity,
    expectedPhysicalPath,
    fsModule,
  });
  return digest;
}

function assertGuardedSourceUnchanged({
  databasePath,
  databaseGuard,
  sourceSha256,
  fsModule = fs,
} = {}) {
  assertDatabaseSidecarFree({ databasePath, fsModule });
  const currentSha256 = hashGuardedFile({
    filePath: databasePath,
    expectedIdentity: databaseGuard.identity,
    expectedPhysicalPath: databaseGuard.physicalPath,
    fsModule,
  });
  assertDatabaseSidecarFree({ databasePath, fsModule });
  if (currentSha256 !== sourceSha256) databaseInvalid();
}

function assertPrivateTemporaryRoot({
  temporaryRoot,
  databaseGuard,
  fsModule = fs,
} = {}) {
  let stat;
  let physicalRoot;
  try {
    stat = fsModule.lstatSync(temporaryRoot);
    physicalRoot = fsModule.realpathSync.native(temporaryRoot);
  } catch {
    databaseInvalid();
  }
  if (
    !safeAbsolutePath(physicalRoot) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    physicalRoot === databaseGuard.physicalRoot ||
    isStrictChildPath(databaseGuard.physicalRoot, physicalRoot)
  ) {
    databaseInvalid();
  }
  return physicalRoot;
}

function cleanupDiscoverySnapshot({
  directoryPath,
  snapshotPath,
  fsModule = fs,
} = {}) {
  let directoryIsOwned = false;
  let cleanupFailed = false;
  try {
    const stat = fsModule.lstatSync(directoryPath);
    const physicalDirectory =
      fsModule.realpathSync.native(directoryPath);
    directoryIsOwned = Boolean(
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      physicalDirectory === directoryPath
    );
  } catch {
    cleanupFailed = true;
  }

  if (directoryIsOwned) {
    const ownedPaths = [
      ...DATABASE_SIDECAR_SUFFIXES.map(
        (suffix) => `${snapshotPath}${suffix}`
      ),
      snapshotPath,
    ];
    for (const ownedPath of ownedPaths) {
      let exists = false;
      let isOwnedFile = false;
      try {
        const stat = fsModule.lstatSync(ownedPath);
        const physicalPath = fsModule.realpathSync.native(ownedPath);
        exists = true;
        isOwnedFile = Boolean(
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          isStrictChildPath(directoryPath, physicalPath)
        );
      } catch (error) {
        if (error?.code !== "ENOENT") cleanupFailed = true;
      }
      if (exists && !isOwnedFile) {
        cleanupFailed = true;
      } else if (isOwnedFile) {
        try {
          fsModule.unlinkSync(ownedPath);
        } catch {
          cleanupFailed = true;
        }
      }
    }
    try {
      if (fsModule.readdirSync(directoryPath).length !== 0) {
        cleanupFailed = true;
      } else {
        fsModule.rmdirSync(directoryPath);
      }
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed || !directoryIsOwned) databaseInvalid();
}

function createDiscoverySnapshot({
  databasePath,
  databaseGuard,
  fsModule = fs,
  temporaryRoot = os.tmpdir(),
} = {}) {
  assertDatabaseSidecarFree({ databasePath, fsModule });
  const sourceSha256 = hashGuardedFile({
    filePath: databasePath,
    expectedIdentity: databaseGuard.identity,
    expectedPhysicalPath: databaseGuard.physicalPath,
    fsModule,
  });
  assertDatabaseSidecarFree({ databasePath, fsModule });

  const physicalTemporaryRoot = assertPrivateTemporaryRoot({
    temporaryRoot,
    databaseGuard,
    fsModule,
  });
  let directoryPath;
  let snapshotPath;
  try {
    directoryPath = fsModule.mkdtempSync(
      path.join(physicalTemporaryRoot, DISCOVERY_SNAPSHOT_PREFIX)
    );
    fsModule.chmodSync(directoryPath, 0o700);
    const directoryStat = fsModule.lstatSync(directoryPath);
    const physicalDirectory =
      fsModule.realpathSync.native(directoryPath);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      physicalDirectory !== directoryPath ||
      !isStrictChildPath(physicalTemporaryRoot, physicalDirectory) ||
      physicalDirectory === databaseGuard.physicalRoot ||
      isStrictChildPath(databaseGuard.physicalRoot, physicalDirectory)
    ) {
      databaseInvalid();
    }
    snapshotPath = path.join(
      directoryPath,
      DISCOVERY_SNAPSHOT_FILE_NAME
    );
    fsModule.copyFileSync(
      databasePath,
      snapshotPath,
      fsModule.constants.COPYFILE_EXCL
    );
    fsModule.chmodSync(snapshotPath, 0o600);
    assertGuardedSourceUnchanged({
      databasePath,
      databaseGuard,
      sourceSha256,
      fsModule,
    });

    const snapshotStat = fsModule.lstatSync(snapshotPath);
    const physicalSnapshot = fsModule.realpathSync.native(snapshotPath);
    if (
      !snapshotStat.isFile() ||
      snapshotStat.isSymbolicLink() ||
      physicalSnapshot !== snapshotPath ||
      !isStrictChildPath(directoryPath, physicalSnapshot)
    ) {
      databaseInvalid();
    }
    const snapshotGuard = Object.freeze({
      physicalPath: physicalSnapshot,
      identity: fileIdentity(snapshotStat),
    });
    const snapshotSha256 = hashGuardedFile({
      filePath: snapshotPath,
      expectedIdentity: snapshotGuard.identity,
      expectedPhysicalPath: snapshotGuard.physicalPath,
      fsModule,
    });
    if (snapshotSha256 !== sourceSha256) databaseInvalid();
    return Object.freeze({
      directoryPath,
      snapshotPath,
      snapshotGuard,
      snapshotSha256,
      sourceSha256,
    });
  } catch (error) {
    if (directoryPath && snapshotPath) {
      try {
        cleanupDiscoverySnapshot({
          directoryPath,
          snapshotPath,
          fsModule,
        });
      } catch {
        // The command still fails closed if private cleanup also fails.
      }
    } else if (directoryPath) {
      try {
        fsModule.rmdirSync(directoryPath);
      } catch {
        // The command still fails closed if private cleanup also fails.
      }
    }
    if (
      error instanceof
        SportsDataIoLiveCapabilityDiscoveryCommandError
    ) {
      throw error;
    }
    databaseInvalid();
  }
}

function assertDiscoverySnapshotUnchanged({
  snapshot,
  fsModule = fs,
} = {}) {
  const currentSha256 = hashGuardedFile({
    filePath: snapshot.snapshotPath,
    expectedIdentity: snapshot.snapshotGuard.identity,
    expectedPhysicalPath: snapshot.snapshotGuard.physicalPath,
    fsModule,
  });
  if (currentSha256 !== snapshot.snapshotSha256) databaseInvalid();
}

function readConfiguration(env, fsModule = fs) {
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    !fsModule ||
    typeof fsModule.lstatSync !== "function" ||
    typeof fsModule.realpathSync?.native !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  const appEnv = requiredText(env, "APP_ENV", 64);
  const liveMode = requiredText(
    env,
    "SPORTSDATAIO_NHL_LIVE_MODE",
    16
  );
  const configuredNhlSeasonKey = requiredText(
    env,
    "CURRENT_NHL_SEASON_KEY",
    8
  );
  if (
    appEnv !== "staging" ||
    requiredText(env, "NODE_ENV", 16) !== "production" ||
    liveMode !== "probe" ||
    configuredNhlSeasonKey !== CONFIGURED_NHL_SEASON_KEY ||
    requiredText(
      env,
      "STAGING_MAINTENANCE_HOLD",
      4
    ) !== "true" ||
    requiredText(env, "LEAGUE_WRITE_MODE", 16) !== "closed" ||
    requiredText(env, "SCHEDULED_JOBS_ENABLED", 5) !== "false" ||
    requiredText(
      env,
      "FREE_AGENT_DRAFT_ROUTES_ENABLED",
      5
    ) !== "false" ||
    requiredText(
      env,
      "ACCOUNT_EMAIL_DELIVERY_ENABLED",
      5
    ) !== "false" ||
    requiredText(env, "DEBUG_ROUTES_ENABLED", 5) !== "false" ||
    requiredText(env, "EMAIL_DELIVERY_MODE", 16) !== "capture" ||
    requiredText(env, "BACKUP_SCHEDULE_ENABLED", 5) !== "false"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  if (
    env.SPORTSDATAIO_NHL_LIVE_API_ORIGIN !== undefined &&
    requiredText(
      env,
      "SPORTSDATAIO_NHL_LIVE_API_ORIGIN",
      200
    ) !== PROVIDER_ORIGIN
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  const persistentRoot = requiredText(
    env,
    "PERSISTENT_DATA_ROOT"
  );
  const databasePath = requiredText(env, "DATABASE_PATH");
  const databaseGuard = validateDatabasePath({
    databasePath,
    persistentRoot,
    fsModule,
  });
  return Object.freeze({
    databasePath,
    databaseGuard,
    discoveryConfiguration: Object.freeze({
      appEnv,
      environmentId: deployedIdentity(
        env,
        "APP_ENVIRONMENT_ID"
      ),
      databaseId: deployedIdentity(env, "DATABASE_ID"),
      configuredNhlSeasonKey,
      liveMode,
      dedicatedLiveApiKey: requiredText(
        env,
        "SPORTSDATAIO_NHL_LIVE_API_KEY",
        1024
      ),
    }),
  });
}

function openDiscoveryDatabase({
  databasePath,
  databaseGuard,
  fsModule = fs,
  DatabaseConstructor = Database,
} = {}) {
  if (
    typeof databasePath !== "string" ||
    !path.isAbsolute(databasePath) ||
    typeof DatabaseConstructor !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .databaseInvalid
    );
  }
  let database;
  try {
    database = new DatabaseConstructor(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: DATABASE_TIMEOUT_MS,
    });
    database.pragma("query_only = ON");
    if (database.pragma("query_only", { simple: true }) !== 1) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
          .databaseInvalid
      );
    }
    if (databaseGuard !== undefined) {
      assertDatabaseFileIdentity({
        databasePath,
        expectedIdentity: databaseGuard.identity,
        expectedPhysicalPath: databaseGuard.physicalPath,
        fsModule,
      });
      const attached = database.pragma("database_list");
      const main = Array.isArray(attached)
        ? attached.find((item) => item?.name === "main")
        : null;
      if (
        !main ||
        typeof main.file !== "string" ||
        fsModule.realpathSync.native(main.file) !==
          databaseGuard.physicalPath
      ) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
            .databaseInvalid
        );
      }
    }
    return database;
  } catch (error) {
    if (database?.open) {
      try {
        database.close();
      } catch {
        // Preserve the authoritative safe database failure.
      }
    }
    if (
      error instanceof
        SportsDataIoLiveCapabilityDiscoveryCommandError
    ) {
      throw error;
    }
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .databaseInvalid
    );
  }
}

async function runSportsDataIoLiveCapabilityDiscoveryCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
  fsModule = fs,
  DatabaseConstructor = Database,
  openDatabase = openDiscoveryDatabase,
  discover = discoverSportsDataIoLiveCapability,
  fetchImpl = globalThis.fetch,
  temporaryRoot = os.tmpdir(),
  nowMs,
  abortSignalFactory,
} = {}) {
  if (
    !output ||
    typeof output.log !== "function" ||
    typeof openDatabase !== "function" ||
    typeof discover !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
        .configurationInvalid
    );
  }
  const { historicalDate } = parseArguments(argv);
  const { databasePath, databaseGuard, discoveryConfiguration } =
    readConfiguration(env, fsModule);
  const snapshot = createDiscoverySnapshot({
    databasePath,
    databaseGuard,
    fsModule,
    temporaryRoot,
  });
  let database;
  let result;
  let serialized;
  try {
    database = openDatabase({
      databasePath: snapshot.snapshotPath,
      databaseGuard: snapshot.snapshotGuard,
      fsModule,
      DatabaseConstructor,
    });
    const options = {
      historicalDate,
      configuration: discoveryConfiguration,
      database,
      fetchImpl,
    };
    if (nowMs !== undefined) options.nowMs = nowMs;
    if (abortSignalFactory !== undefined) {
      options.abortSignalFactory = abortSignalFactory;
    }
    result = await discover(options);
    try {
      serialized = serializeCanonicalJsonV1(result);
    } catch {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
          .internalFailed
      );
    }
  } finally {
    let closeFailed = false;
    let snapshotInvalid = false;
    let cleanupFailed = false;
    let sourceInvalid = false;
    if (database?.open) {
      try {
        database.close();
      } catch {
        closeFailed = true;
      }
    }
    try {
      assertDiscoverySnapshotUnchanged({ snapshot, fsModule });
    } catch {
      snapshotInvalid = true;
    }
    try {
      cleanupDiscoverySnapshot({
        directoryPath: snapshot.directoryPath,
        snapshotPath: snapshot.snapshotPath,
        fsModule,
      });
    } catch {
      cleanupFailed = true;
    }
    try {
      assertGuardedSourceUnchanged({
        databasePath,
        databaseGuard,
        sourceSha256: snapshot.sourceSha256,
        fsModule,
      });
    } catch {
      sourceInvalid = true;
    }
    if (
      closeFailed ||
      snapshotInvalid ||
      cleanupFailed ||
      sourceInvalid
    ) {
      databaseInvalid();
    }
  }
  output.log(serialized);
  return result;
}

function exitCodeForError(error) {
  return PROVIDER_FAILURE_CODES.has(error?.code) ? 2 : 1;
}

async function main({
  command = runSportsDataIoLiveCapabilityDiscoveryCommand,
  output = console,
  processObject = process,
} = {}) {
  try {
    const result = await command({ output });
    processObject.exitCode = result ? 0 : 1;
    return result;
  } catch (error) {
    processObject.exitCode = exitCodeForError(error);
    const code = SAFE_ERROR_CODES.has(error?.code)
      ? error.code
      : SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES
          .internalFailed;
    output.error(JSON.stringify({
      error: {
        code,
        message:
          "The SportsDataIO live capability discovery command failed safely.",
      },
    }));
    return null;
  }
}

if (require.main === module) void main();

module.exports = {
  SPORTS_DATA_IO_LIVE_CAPABILITY_DISCOVERY_COMMAND_ERROR_CODES,
  SportsDataIoLiveCapabilityDiscoveryCommandError,
  exitCodeForError,
  assertDatabaseFileIdentity,
  main,
  openDiscoveryDatabase,
  parseArguments,
  readConfiguration,
  runSportsDataIoLiveCapabilityDiscoveryCommand,
  validateDatabasePath,
};
