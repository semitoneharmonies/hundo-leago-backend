const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  TextDecoder,
} = require("node:util");

const {
  serializeCanonicalJsonV1,
} = require("../../domain/leagues/seasonRolloverEvidencePolicy");

const SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES =
  512 * 1024;
const SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE =
  0o700;
const SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE =
  0o600;
const BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });
const SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_LOCK_VERSION = 1;
const SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FAILURE_SEAMS =
  Object.freeze([
    "lock_acquired",
    "prior_snapshot_captured",
    "temp_opened",
    "temp_written",
    "temp_fsynced",
    "temp_reread_verified",
    "before_rename",
    "after_rename",
    "directory_fsynced",
    "final_reread_verified",
  ]);
const SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES =
  Object.freeze({
    argumentInvalid:
      "SPORTSDATAIO_LIVE_CAPABILITY_ARTIFACT_ARGUMENT_INVALID",
    pathUnsafe:
      "SPORTSDATAIO_LIVE_CAPABILITY_ARTIFACT_PATH_UNSAFE",
    notFound:
      "SPORTSDATAIO_LIVE_CAPABILITY_ARTIFACT_NOT_FOUND",
    verificationFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_ARTIFACT_VERIFICATION_FAILED",
    publicationContended:
      "SPORTSDATAIO_LIVE_CAPABILITY_ARTIFACT_PUBLICATION_CONTENDED",
    publicationFailed:
      "SPORTSDATAIO_LIVE_CAPABILITY_ARTIFACT_PUBLICATION_FAILED",
  });

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const FACTORY_KEYS = Object.freeze([
  "persistentRoot",
  "artifactPath",
  "authenticator",
  "fsModule",
  "randomUUID",
  "failureInjector",
]);
const READ_KEYS = Object.freeze([
  "expectedBindings",
  "nowMs",
]);
const PUBLISH_KEYS = Object.freeze([
  "artifact",
  "expectedBindings",
  "nowMs",
]);
const REQUIRED_FS_METHODS = Object.freeze([
  "closeSync",
  "fstatSync",
  "fsyncSync",
  "linkSync",
  "lstatSync",
  "mkdirSync",
  "openSync",
  "readFileSync",
  "readSync",
  "realpathSync",
  "renameSync",
  "unlinkSync",
  "writeFileSync",
]);
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

class SportsDataIoLiveCapabilityArtifactError extends Error {
  constructor(code) {
    super("The SportsDataIO live capability artifact operation failed.");
    this.name = "SportsDataIoLiveCapabilityArtifactError";
    this.code = code;
  }
}

function fail(code) {
  throw new SportsDataIoLiveCapabilityArtifactError(code);
}

function isArtifactError(error) {
  return error instanceof SportsDataIoLiveCapabilityArtifactError;
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, code) {
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(code);
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(code);
    }
  }
  return value;
}

function exactFactoryOptions(options) {
  if (!isPlainObject(options)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .argumentInvalid
    );
  }
  const presentKeys = FACTORY_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(options, key)
  );
  exactObject(
    options,
    presentKeys,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .argumentInvalid
  );
  for (const key of [
    "persistentRoot",
    "artifactPath",
    "authenticator",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .argumentInvalid
      );
    }
  }
  return options;
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

function childRelativePath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  return relative;
}

function safeStatSize(stat, maximum, code) {
  if (typeof stat?.size === "bigint") {
    if (
      stat.size < 1n ||
      stat.size > BigInt(maximum)
    ) {
      fail(code);
    }
    return Number(stat.size);
  }
  if (
    !Number.isSafeInteger(stat?.size) ||
    stat.size < 1 ||
    stat.size > maximum
  ) {
    fail(code);
  }
  return stat.size;
}

function sameFileIdentity(left, right) {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    typeof left.dev === "bigint" &&
    typeof left.ino === "bigint" &&
    typeof right.dev === "bigint" &&
    typeof right.ino === "bigint" &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    (
      left.ino !== 0n ||
      (
        typeof left.birthtimeNs === "bigint" &&
        typeof right.birthtimeNs === "bigint" &&
        left.birthtimeNs === right.birthtimeNs
      )
    )
  );
}

function sameFileTimestamps(left, right) {
  return (
    typeof left?.mtimeNs === "bigint" &&
    typeof left.ctimeNs === "bigint" &&
    typeof right?.mtimeNs === "bigint" &&
    typeof right.ctimeNs === "bigint" &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isSymbolicOrNonFile(stat) {
  return !stat.isFile() || stat.isSymbolicLink();
}

function isSymbolicOrNonDirectory(stat) {
  return !stat.isDirectory() || stat.isSymbolicLink();
}

function enforceMode(stat, expectedMode, code) {
  const mode = stat?.mode;
  const modeMatches =
    typeof mode === "bigint"
      ? (mode & 0o777n) === BigInt(expectedMode)
      : Number.isInteger(mode) &&
        (mode & 0o777) === expectedMode;
  if (
    process.platform !== "win32" &&
    !modeMatches
  ) {
    fail(code);
  }
}

function realpathNative(fsModule, value) {
  if (
    typeof fsModule.realpathSync?.native !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .argumentInvalid
    );
  }
  return fsModule.realpathSync.native(value);
}

function assertPhysicalPathEquals(
  fsModule,
  requestedPath,
  code
) {
  let physical;
  try {
    physical = realpathNative(fsModule, requestedPath);
  } catch {
    fail(code);
  }
  if (path.relative(requestedPath, physical) !== "") {
    fail(code);
  }
  return physical;
}

function existingPathComponents(value) {
  const parsed = path.parse(value);
  const relative = value.slice(parsed.root.length);
  const names = relative
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

function assertNoReparseComponents(
  fsModule,
  value,
  { allowMissing = false } = {}
) {
  for (const component of existingPathComponents(value)) {
    let stat;
    try {
      stat = fsModule.lstatSync(component);
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") {
        return;
      }
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .pathUnsafe
      );
    }
    if (stat.isSymbolicLink()) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .pathUnsafe
      );
    }
  }
}

function validateRoot(fsModule, persistentRoot) {
  if (
    !safeAbsolutePath(persistentRoot) ||
    path.parse(persistentRoot).root === persistentRoot
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  assertNoReparseComponents(fsModule, persistentRoot);
  let stat;
  try {
    stat = fsModule.lstatSync(persistentRoot);
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  if (isSymbolicOrNonDirectory(stat)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  return assertPhysicalPathEquals(
    fsModule,
    persistentRoot,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .pathUnsafe
  );
}

function validateArtifactLayout(
  fsModule,
  persistentRoot,
  artifactPath
) {
  const root = validateRoot(fsModule, persistentRoot);
  if (!safeAbsolutePath(artifactPath)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  childRelativePath(root, artifactPath);
  const artifactDirectory = path.dirname(artifactPath);
  childRelativePath(root, artifactDirectory);
  if (
    path.extname(artifactPath).toLowerCase() !== ".json" ||
    path.basename(artifactPath).startsWith(".")
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  assertNoReparseComponents(fsModule, artifactDirectory, {
    allowMissing: true,
  });
  return Object.freeze({
    persistentRoot: root,
    artifactDirectory,
    artifactPath,
    lockPath: path.join(
      artifactDirectory,
      `.${path.basename(artifactPath)}.publish.lock`
    ),
  });
}

function assertSafeDirectory(layout, fsModule) {
  validateRoot(fsModule, layout.persistentRoot);
  let stat;
  try {
    stat = fsModule.lstatSync(layout.artifactDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .notFound
      );
    }
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  if (isSymbolicOrNonDirectory(stat)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .pathUnsafe
    );
  }
  assertNoReparseComponents(fsModule, layout.artifactDirectory);
  enforceMode(
    stat,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .pathUnsafe
  );
  assertPhysicalPathEquals(
    fsModule,
    layout.artifactDirectory,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .pathUnsafe
  );
}

function ensureSafeDirectory(layout, fsModule) {
  validateRoot(fsModule, layout.persistentRoot);
  const relative = childRelativePath(
    layout.persistentRoot,
    layout.artifactDirectory
  );
  const names = relative.split(path.sep);
  let current = layout.persistentRoot;
  for (const name of names) {
    current = path.join(current, name);
    try {
      fsModule.mkdirSync(current, {
        mode:
          SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
            .publicationFailed
        );
      }
    }
    let stat;
    try {
      stat = fsModule.lstatSync(current);
    } catch {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .pathUnsafe
      );
    }
    if (isSymbolicOrNonDirectory(stat)) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .pathUnsafe
      );
    }
    enforceMode(
      stat,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
    assertPhysicalPathEquals(
      fsModule,
      current,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  assertSafeDirectory(layout, fsModule);
}

function validateFsModule(fsModule) {
  for (const method of REQUIRED_FS_METHODS) {
    if (typeof fsModule?.[method] !== "function") {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .argumentInvalid
      );
    }
  }
  if (
    typeof fsModule.realpathSync?.native !== "function" ||
    typeof fsModule.constants !== "object"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .argumentInvalid
    );
  }
  return fsModule;
}

function readExactBytesFromDescriptor({
  descriptor,
  expectedSize,
  fsModule,
}) {
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    let count;
    try {
      count = fsModule.readSync(
        descriptor,
        bytes,
        offset,
        expectedSize - offset,
        offset
      );
    } catch {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    if (!Number.isSafeInteger(count) || count < 1) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    offset += count;
  }
  const extra = Buffer.alloc(1);
  let extraCount;
  try {
    extraCount = fsModule.readSync(
      descriptor,
      extra,
      0,
      1,
      expectedSize
    );
  } catch {
    bytes.fill(0);
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  } finally {
    extra.fill(0);
  }
  if (extraCount !== 0) {
    bytes.fill(0);
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  return bytes;
}

function openReadOnlyNoFollow(filePath, fsModule) {
  const flags =
    fsModule.constants.O_RDONLY |
    (fsModule.constants.O_NOFOLLOW || 0);
  try {
    return fsModule.openSync(filePath, flags);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .notFound
      );
    }
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
}

function parseCanonicalArtifact(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (serializeCanonicalJsonV1(parsed) !== raw) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
  } catch (error) {
    if (isArtifactError(error)) throw error;
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  return parsed;
}

function selfBindings(artifact) {
  const evidence = artifact?.evidence;
  return {
    appEnv: evidence?.appEnv,
    environmentId: evidence?.environmentId,
    backendBuildId: evidence?.backendBuildId,
    origin: evidence?.origin,
    configuredNhlSeasonKey:
      evidence?.configuredNhlSeasonKey,
    probeNhlSeasonKey: evidence?.probeNhlSeasonKey,
    probeKind: evidence?.probeKind,
    probeManifestSha256: evidence?.probeManifestSha256,
  };
}

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function verifyParsedArtifact({
  artifact,
  expectedBindings,
  nowMs,
  authenticator,
}) {
  let verification;
  try {
    verification = authenticator.verifyArtifact({
      artifact,
      expectedBindings,
      nowMs,
    });
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  deepFreeze(artifact);
  return verification;
}

function readVerifiedFile({
  layout,
  filePath,
  expectedBindings,
  nowMs,
  authenticator,
  fsModule,
  selfBound = false,
}) {
  assertSafeDirectory(layout, fsModule);
  if (path.dirname(filePath) !== layout.artifactDirectory) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  let before;
  try {
    before = fsModule.lstatSync(
      filePath,
      BIGINT_STAT_OPTIONS
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .notFound
      );
    }
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  if (isSymbolicOrNonFile(before)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
  enforceMode(
    before,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .verificationFailed
  );
  const size = safeStatSize(
    before,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .verificationFailed
  );
  assertPhysicalPathEquals(
    fsModule,
    filePath,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .pathUnsafe
  );
  let descriptor;
  let bytes;
  try {
    descriptor = openReadOnlyNoFollow(filePath, fsModule);
    const opened = fsModule.fstatSync(
      descriptor,
      BIGINT_STAT_OPTIONS
    );
    if (
      isSymbolicOrNonFile(opened) ||
      !sameFileIdentity(before, opened) ||
      safeStatSize(
        opened,
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES,
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      ) !== size ||
      !sameFileTimestamps(before, opened)
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    enforceMode(
      opened,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
    bytes = readExactBytesFromDescriptor({
      descriptor,
      expectedSize: size,
      fsModule,
    });
    const afterDescriptor = fsModule.fstatSync(
      descriptor,
      BIGINT_STAT_OPTIONS
    );
    const afterPath = fsModule.lstatSync(
      filePath,
      BIGINT_STAT_OPTIONS
    );
    if (
      !sameFileIdentity(opened, afterDescriptor) ||
      !sameFileIdentity(opened, afterPath) ||
      safeStatSize(
        afterDescriptor,
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES,
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      ) !== size ||
      safeStatSize(
        afterPath,
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES,
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      ) !== size ||
      !sameFileTimestamps(opened, afterDescriptor) ||
      !sameFileTimestamps(opened, afterPath)
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
  } catch (error) {
    if (isArtifactError(error)) throw error;
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        if (bytes) bytes.fill(0);
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
            .verificationFailed
        );
      }
    }
  }
  let raw;
  try {
    raw = utf8Decoder.decode(bytes);
  } catch {
    bytes.fill(0);
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  bytes.fill(0);
  const artifact = parseCanonicalArtifact(raw);
  const bindings = selfBound
    ? selfBindings(artifact)
    : expectedBindings;
  const verificationTime = selfBound
    ? artifact?.evidence?.issuedAtMs
    : nowMs;
  const verification = verifyParsedArtifact({
    artifact,
    expectedBindings: bindings,
    nowMs: verificationTime,
    authenticator,
  });
  return Object.freeze({
    raw,
    artifact,
    verification,
    identity: before,
    byteLength: size,
  });
}

function tryReadVerifiedFile(options) {
  try {
    return readVerifiedFile(options);
  } catch (error) {
    if (
      isArtifactError(error) &&
      error.code ===
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .notFound
    ) {
      return null;
    }
    throw error;
  }
}

function safeUuid(randomUUID) {
  let value;
  try {
    value = randomUUID();
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
  return value;
}

function writeAll({ descriptor, raw, fsModule }) {
  try {
    fsModule.writeFileSync(descriptor, raw, {
      encoding: "utf8",
    });
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
}

function openOwnedFile({ filePath, fsModule }) {
  const flags =
    fsModule.constants.O_WRONLY |
    fsModule.constants.O_CREAT |
    fsModule.constants.O_EXCL |
    (fsModule.constants.O_NOFOLLOW || 0);
  try {
    return fsModule.openSync(
      filePath,
      flags,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationContended
      );
    }
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
}

function finalizeOwnedFile({
  descriptor,
  filePath,
  fsModule,
}) {
  try {
    fsModule.fsyncSync(descriptor);
    return captureOwnedFileIdentity({
      descriptor,
      filePath,
      fsModule,
    });
  } catch (error) {
    if (isArtifactError(error)) throw error;
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
}

function captureOwnedFileIdentity({
  descriptor,
  filePath,
  fsModule,
}) {
  try {
    const opened = fsModule.fstatSync(
      descriptor,
      BIGINT_STAT_OPTIONS
    );
    const linked = fsModule.lstatSync(
      filePath,
      BIGINT_STAT_OPTIONS
    );
    if (
      isSymbolicOrNonFile(opened) ||
      isSymbolicOrNonFile(linked) ||
      !sameFileIdentity(opened, linked)
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
    enforceMode(
      opened,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
    enforceMode(
      linked,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
    return linked;
  } catch (error) {
    if (isArtifactError(error)) throw error;
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
}

function closeOwnedDescriptor(descriptor, fsModule) {
  if (descriptor === null || descriptor === undefined) return;
  try {
    fsModule.closeSync(descriptor);
  } catch {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
}

function restoreQuarantinedForeign({
  originalPath,
  quarantinePath,
  fsModule,
}) {
  try {
    fsModule.linkSync(quarantinePath, originalPath);
    fsModule.unlinkSync(quarantinePath);
  } catch {
    // A foreign file is preserved rather than overwriting a newer owner.
  }
}

function removeExactOwnedFile({
  layout,
  filePath,
  identity,
  expectedRaw,
  fsModule,
  randomUUID,
}) {
  if (!identity) return false;
  const quarantinePath = path.join(
    layout.artifactDirectory,
    `.${path.basename(filePath)}.release-${safeUuid(randomUUID)}`
  );
  try {
    fsModule.renameSync(filePath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
  try {
    const stat = fsModule.lstatSync(
      quarantinePath,
      BIGINT_STAT_OPTIONS
    );
    const expectedBytes =
      expectedRaw === null
        ? null
        : Buffer.byteLength(expectedRaw, "utf8");
    if (
      isSymbolicOrNonFile(stat) ||
      !sameFileIdentity(identity, stat) ||
      (
        expectedRaw !== null &&
        (
          safeStatSize(
            stat,
            SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES,
            SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
              .publicationFailed
          ) !== expectedBytes ||
          fsModule.readFileSync(quarantinePath, "utf8") !==
            expectedRaw
        )
      )
    ) {
      restoreQuarantinedForeign({
        originalPath: filePath,
        quarantinePath,
        fsModule,
      });
      return false;
    }
    fsModule.unlinkSync(quarantinePath);
    return true;
  } catch {
    restoreQuarantinedForeign({
      originalPath: filePath,
      quarantinePath,
      fsModule,
    });
    return false;
  }
}

function lockRaw({ ownerId, artifactSha256, nowMs }) {
  return serializeCanonicalJsonV1({
    lockVersion:
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_LOCK_VERSION,
    ownerId,
    processId: process.pid,
    createdAtMs: nowMs,
    artifactSha256,
  });
}

function acquireLock({
  layout,
  artifact,
  nowMs,
  fsModule,
  randomUUID,
}) {
  const ownerId = safeUuid(randomUUID);
  const raw = lockRaw({
    ownerId,
    artifactSha256: artifact.evidenceSha256,
    nowMs,
  });
  let descriptor;
  let identity = null;
  try {
    descriptor = openOwnedFile({
      filePath: layout.lockPath,
      fsModule,
    });
    identity = captureOwnedFileIdentity({
      descriptor,
      filePath: layout.lockPath,
      fsModule,
    });
    writeAll({ descriptor, raw, fsModule });
    identity = finalizeOwnedFile({
      descriptor,
      filePath: layout.lockPath,
      fsModule,
    });
    return {
      descriptor,
      identity,
      raw,
      ownerId,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        // The original publication error remains authoritative.
      }
    }
    removeExactOwnedFile({
      layout,
      filePath: layout.lockPath,
      identity,
      expectedRaw: null,
      fsModule,
      randomUUID,
    });
    throw error;
  }
}

function releaseLock({
  layout,
  owner,
  fsModule,
  randomUUID,
}) {
  if (!owner) return;
  try {
    fsModule.closeSync(owner.descriptor);
  } catch {
    // File identity and exact bytes still govern release.
  }
  removeExactOwnedFile({
    layout,
    filePath: layout.lockPath,
    identity: owner.identity,
    expectedRaw: owner.raw,
    fsModule,
    randomUUID,
  });
}

function fsyncDirectory(layout, fsModule) {
  let descriptor;
  try {
    descriptor = fsModule.openSync(
      layout.artifactDirectory,
      fsModule.constants.O_RDONLY
    );
    const stat = fsModule.fstatSync(descriptor);
    if (isSymbolicOrNonDirectory(stat)) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
    fsModule.fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EACCES", "EISDIR", "EINVAL", "EPERM"].includes(
        error?.code
      )
    ) {
      return;
    }
    if (isArtifactError(error)) throw error;
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        // Preserve the fsync result.
      }
    }
  }
}

function assertFinalSnapshot({
  layout,
  snapshot,
  authenticator,
  fsModule,
}) {
  const current = tryReadVerifiedFile({
    layout,
    filePath: layout.artifactPath,
    authenticator,
    fsModule,
    selfBound: true,
  });
  if (snapshot === null) {
    if (current !== null) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
    return;
  }
  if (
    current === null ||
    current.raw !== snapshot.raw ||
    !sameFileIdentity(current.identity, snapshot.identity)
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
}

function createVerifiedOwnedFile({
  layout,
  filePath,
  raw,
  artifact,
  expectedBindings,
  nowMs,
  authenticator,
  fsModule,
  randomUUID,
}) {
  let descriptor;
  let identity = null;
  try {
    descriptor = openOwnedFile({ filePath, fsModule });
    identity = captureOwnedFileIdentity({
      descriptor,
      filePath,
      fsModule,
    });
    writeAll({ descriptor, raw, fsModule });
    identity = finalizeOwnedFile({
      descriptor,
      filePath,
      fsModule,
    });
    closeOwnedDescriptor(descriptor, fsModule);
    descriptor = undefined;
    const verified = readVerifiedFile({
      layout,
      filePath,
      expectedBindings,
      nowMs,
      authenticator,
      fsModule,
      selfBound: expectedBindings === null,
    });
    if (
      verified.raw !== raw ||
      verified.artifact.evidenceSha256 !==
        artifact.evidenceSha256 ||
      !sameFileIdentity(identity, verified.identity)
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
    return verified;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    removeExactOwnedFile({
      layout,
      filePath,
      identity,
      expectedRaw: null,
      fsModule,
      randomUUID,
    });
    throw error;
  }
}

function rollbackPublication({
  layout,
  prior,
  candidateRaw,
  candidateIdentity,
  authenticator,
  fsModule,
  randomUUID,
}) {
  if (prior === null) {
    const removed = removeExactOwnedFile({
      layout,
      filePath: layout.artifactPath,
      identity: candidateIdentity,
      expectedRaw: candidateRaw,
      fsModule,
      randomUUID,
    });
    if (!removed) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
    fsyncDirectory(layout, fsModule);
    return;
  }

  const rollbackPath = path.join(
    layout.artifactDirectory,
    `.${path.basename(layout.artifactPath)}.rollback-` +
      safeUuid(randomUUID)
  );
  let rollback = null;
  try {
    rollback = createVerifiedOwnedFile({
      layout,
      filePath: rollbackPath,
      raw: prior.raw,
      artifact: prior.artifact,
      expectedBindings: null,
      nowMs: prior.artifact.evidence.issuedAtMs,
      authenticator,
      fsModule,
      randomUUID,
    });
    const current = readVerifiedFile({
      layout,
      filePath: layout.artifactPath,
      expectedBindings: null,
      authenticator,
      fsModule,
      selfBound: true,
    });
    if (
      current.raw !== candidateRaw ||
      !sameFileIdentity(current.identity, candidateIdentity)
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
    fsModule.renameSync(rollbackPath, layout.artifactPath);
    rollback = null;
    fsyncDirectory(layout, fsModule);
    const restored = readVerifiedFile({
      layout,
      filePath: layout.artifactPath,
      expectedBindings: null,
      authenticator,
      fsModule,
      selfBound: true,
    });
    if (restored.raw !== prior.raw) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
  } catch (error) {
    if (rollback !== null) {
      removeExactOwnedFile({
        layout,
        filePath: rollbackPath,
        identity: rollback.identity,
        expectedRaw: prior.raw,
        fsModule,
        randomUUID,
      });
    }
    if (isArtifactError(error)) throw error;
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationFailed
    );
  }
}

function receipt(status, layout, artifact, byteLength) {
  return Object.freeze({
    status,
    artifactPath: layout.artifactPath,
    evidenceId: artifact.evidence.evidenceId,
    evidenceSha256: artifact.evidenceSha256,
    artifactBytes: byteLength,
  });
}

function createSportsDataIoLiveCapabilityArtifact(options = {}) {
  const configuration = exactFactoryOptions(options);
  const fsModule = validateFsModule(configuration.fsModule || fs);
  if (
    !configuration.authenticator ||
    typeof configuration.authenticator.verifyArtifact !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .argumentInvalid
    );
  }
  const randomUUID = configuration.randomUUID || crypto.randomUUID;
  const failureInjector = configuration.failureInjector || (() => {});
  if (
    typeof randomUUID !== "function" ||
    typeof failureInjector !== "function"
  ) {
    fail(
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .argumentInvalid
    );
  }
  const layout = validateArtifactLayout(
    fsModule,
    configuration.persistentRoot,
    configuration.artifactPath
  );

  function inject(step) {
    try {
      failureInjector(step);
    } catch {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
  }

  function readAndVerify(input = {}) {
    const request = exactObject(
      input,
      READ_KEYS,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .argumentInvalid
    );
    try {
      const stored = readVerifiedFile({
        layout,
        filePath: layout.artifactPath,
        expectedBindings: request.expectedBindings,
        nowMs: request.nowMs,
        authenticator: configuration.authenticator,
        fsModule,
      });
      return Object.freeze({
        status: "verified",
        artifactPath: layout.artifactPath,
        artifactBytes: stored.byteLength,
        artifact: stored.artifact,
        verification: stored.verification,
      });
    } catch (error) {
      if (isArtifactError(error)) throw error;
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
  }

  function publish(input = {}) {
    const request = exactObject(
      input,
      PUBLISH_KEYS,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .argumentInvalid
    );
    let candidateVerification;
    let candidateRaw;
    let candidateArtifact;
    let publicationBindings;
    try {
      candidateRaw = serializeCanonicalJsonV1(request.artifact);
      candidateArtifact = parseCanonicalArtifact(candidateRaw);
      publicationBindings = deepFreeze(
        JSON.parse(
          serializeCanonicalJsonV1(request.expectedBindings)
        )
      );
      candidateVerification =
        configuration.authenticator.verifyArtifact({
          artifact: candidateArtifact,
          expectedBindings: publicationBindings,
          nowMs: request.nowMs,
        });
      deepFreeze(candidateArtifact);
    } catch {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    const candidateBytes = Buffer.byteLength(candidateRaw, "utf8");
    if (
      candidateBytes < 1 ||
      candidateBytes >
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES
    ) {
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    ensureSafeDirectory(layout, fsModule);

    const initial = tryReadVerifiedFile({
      layout,
      filePath: layout.artifactPath,
      authenticator: configuration.authenticator,
      fsModule,
      selfBound: true,
    });
    if (initial?.raw === candidateRaw) {
      return receipt(
        "replayed",
        layout,
        candidateArtifact,
        candidateBytes
      );
    }

    let lock = null;
    let prior = null;
    let temporary = null;
    let temporaryDescriptor;
    let ownsTemporary = false;
    let renamed = false;
    let candidateIdentity = null;
    const temporaryPath = path.join(
      layout.artifactDirectory,
      `.${path.basename(layout.artifactPath)}.temp-` +
        safeUuid(randomUUID)
    );
    try {
      lock = acquireLock({
        layout,
        artifact: candidateArtifact,
        nowMs: request.nowMs,
        fsModule,
        randomUUID,
      });
      inject("lock_acquired");
      prior = tryReadVerifiedFile({
        layout,
        filePath: layout.artifactPath,
        authenticator: configuration.authenticator,
        fsModule,
        selfBound: true,
      });
      if (prior?.raw === candidateRaw) {
        return receipt(
          "replayed",
          layout,
          candidateArtifact,
          candidateBytes
        );
      }
      inject("prior_snapshot_captured");

      temporaryDescriptor = openOwnedFile({
        filePath: temporaryPath,
        fsModule,
      });
      candidateIdentity = captureOwnedFileIdentity({
        descriptor: temporaryDescriptor,
        filePath: temporaryPath,
        fsModule,
      });
      ownsTemporary = true;
      inject("temp_opened");
      writeAll({
        descriptor: temporaryDescriptor,
        raw: candidateRaw,
        fsModule,
      });
      inject("temp_written");
      candidateIdentity = finalizeOwnedFile({
        descriptor: temporaryDescriptor,
        filePath: temporaryPath,
        fsModule,
      });
      inject("temp_fsynced");
      closeOwnedDescriptor(temporaryDescriptor, fsModule);
      temporaryDescriptor = undefined;
      temporary = readVerifiedFile({
        layout,
        filePath: temporaryPath,
        expectedBindings: publicationBindings,
        nowMs: request.nowMs,
        authenticator: configuration.authenticator,
        fsModule,
      });
      if (
        temporary.raw !== candidateRaw ||
        temporary.verification.evidenceSha256 !==
          candidateVerification.evidenceSha256 ||
        !sameFileIdentity(
          temporary.identity,
          candidateIdentity
        )
      ) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
            .publicationFailed
        );
      }
      inject("temp_reread_verified");
      assertFinalSnapshot({
        layout,
        snapshot: prior,
        authenticator: configuration.authenticator,
        fsModule,
      });
      inject("before_rename");
      try {
        fsModule.renameSync(
          temporaryPath,
          layout.artifactPath
        );
      } catch {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
            .publicationFailed
        );
      }
      temporary = null;
      ownsTemporary = false;
      renamed = true;
      inject("after_rename");
      fsyncDirectory(layout, fsModule);
      inject("directory_fsynced");
      const final = readVerifiedFile({
        layout,
        filePath: layout.artifactPath,
        expectedBindings: publicationBindings,
        nowMs: request.nowMs,
        authenticator: configuration.authenticator,
        fsModule,
      });
      if (
        final.raw !== candidateRaw ||
        !sameFileIdentity(final.identity, candidateIdentity)
      ) {
        fail(
          SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
            .publicationFailed
        );
      }
      inject("final_reread_verified");
      renamed = false;
      return receipt(
        prior === null ? "published" : "replaced",
        layout,
        candidateArtifact,
        candidateBytes
      );
    } catch (error) {
      if (renamed) {
        try {
          rollbackPublication({
            layout,
            prior,
            candidateRaw,
            candidateIdentity,
            authenticator: configuration.authenticator,
            fsModule,
            randomUUID,
          });
          renamed = false;
        } catch {
          fail(
            SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
              .publicationFailed
          );
        }
      }
      if (isArtifactError(error)) throw error;
      fail(
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    } finally {
      if (temporaryDescriptor !== undefined) {
        try {
          fsModule.closeSync(temporaryDescriptor);
        } catch {
          // Exact identity still governs owned temporary cleanup.
        }
      }
      if (ownsTemporary) {
        removeExactOwnedFile({
          layout,
          filePath: temporaryPath,
          identity: candidateIdentity,
          expectedRaw: null,
          fsModule,
          randomUUID,
        });
      }
      releaseLock({
        layout,
        owner: lock,
        fsModule,
        randomUUID,
      });
    }
  }

  return Object.freeze({
    artifactPath: layout.artifactPath,
    publish,
    readAndVerify,
  });
}

module.exports = {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FAILURE_SEAMS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_LOCK_VERSION,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES,
  SportsDataIoLiveCapabilityArtifactError,
  createSportsDataIoLiveCapabilityArtifact,
};
