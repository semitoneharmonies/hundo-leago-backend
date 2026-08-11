const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  openReadonlyDatabase,
} = require("../database/connection");
const {
  RESOURCE_KEYS,
  STAGING_DESCRIPTOR_VERSION,
  descriptorSha256,
  loadAndValidateStagingDescriptor,
} = require("../database/stagingEnvironment");
const {
  projectSanitizedSourceBundleEvidence,
  projectSucceededResetMigrationReport,
} = require("./migrationReportEvidence");
const {
  assertResetOriginalLeagueContinuityBaseline,
  captureResetOriginalLeagueContinuityBaseline,
} = require("./resetOriginalLeagueContinuityEvidence");
const {
  loadAndValidateResetManifest,
} = require("./resetManifest");
const {
  SOURCE_BUNDLE_FILE_NAME,
  SOURCE_BUNDLE_MANIFEST_VERSION,
  SOURCE_LABEL_PATTERN,
  canonicalize,
  verifySourceBundle,
} = require("./sourceInventory");
const {
  validateVerificationPaths,
  verificationHash,
  verifyStagingImport,
} = require("./verifyStagingImport");

const RESET_IMPORT_ARTIFACT_VERSION = 1;
const RESET_IMPORT_ARTIFACT_PAYLOAD_FILE =
  "reset-import-verification.json";
const RESET_IMPORT_ARTIFACT_MANIFEST_FILE =
  "artifact-manifest.json";
const RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX =
  "reset-import-verification-v1-";
const RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_VERSION = 1;
const RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_LEASE_MS =
  5 * 60 * 1000;
const RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_GRACE_MS =
  30 * 1000;
const RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_MAX_BYTES =
  2 * 1024;
const RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_ATTEMPTS = 3;
const VALIDATED_RESET_IMPORT_ARTIFACTS =
  new WeakSet();
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SOURCE_BUNDLE_ID_PATTERN =
  /^source-bundle-v1-[a-f0-9]{64}$/;

const RESET_IMPORT_ARTIFACT_ERROR_CODES = Object.freeze({
  argumentInvalid:
    "RESET_IMPORT_ARTIFACT_ARGUMENT_INVALID",
  verificationFailed:
    "RESET_IMPORT_ARTIFACT_VERIFICATION_FAILED",
  artifactConflict:
    "RESET_IMPORT_ARTIFACT_CONFLICT",
  publicationFailed:
    "RESET_IMPORT_ARTIFACT_PUBLICATION_FAILED",
});

class ResetImportVerificationArtifactError extends Error {
  constructor(code, { cause } = {}) {
    super(
      "The reset import verification artifact operation failed.",
      cause === undefined ? undefined : { cause }
    );
    this.name = "ResetImportVerificationArtifactError";
    this.code = code;
  }
}

function fail(code, options) {
  throw new ResetImportVerificationArtifactError(
    code,
    options
  );
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
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, expectedKeys) {
  if (!isPlainObject(value)) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  return value;
}

function nonnegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  return value;
}

function assertJsonTree(value, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    return;
  }
  if (
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) && !isPlainObject(value))
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  ancestors.add(value);
  Object.values(value).forEach((child) =>
    assertJsonTree(child, ancestors)
  );
  ancestors.delete(value);
}

function deepFreeze(value) {
  if (
    value &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function normalizeOptions(options) {
  if (!isPlainObject(options)) {
    fail(RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid);
  }
  const required = [
    "descriptorPath",
    "sourceBundleDirectory",
    "databasePath",
    "resetManifestPath",
    "importReportPath",
    "operatingMode",
  ];
  const optional = [
    "repositoryRoot",
    "temporaryRoot",
    "fsModule",
  ];
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(options, key)) ||
    Object.keys(options).some((key) => !allowed.has(key))
  ) {
    fail(RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid);
  }
  for (const key of required) {
    if (
      typeof options[key] !== "string" ||
      options[key].trim() === ""
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid
      );
    }
  }
  if (options.operatingMode !== "OFFSEASON_RESET") {
    fail(RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid);
  }
  const fsModule = options.fsModule || fs;
  for (const method of [
    "closeSync",
    "copyFileSync",
    "existsSync",
    "fstatSync",
    "fsyncSync",
    "linkSync",
    "lstatSync",
    "mkdirSync",
    "mkdtempSync",
    "openSync",
    "readFileSync",
    "readSync",
    "readdirSync",
    "realpathSync",
    "renameSync",
    "rmSync",
    "statSync",
    "unlinkSync",
    "writeFileSync",
  ]) {
    if (typeof fsModule[method] !== "function") {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid
      );
    }
  }
  if (
    typeof fsModule.realpathSync.native !==
    "function"
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid
    );
  }
  for (const key of ["repositoryRoot", "temporaryRoot"]) {
    if (
      options[key] !== undefined &&
      (
        typeof options[key] !== "string" ||
        options[key].trim() === ""
      )
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid
      );
    }
  }
  return Object.freeze({
    descriptorPath: options.descriptorPath,
    sourceBundleDirectory:
      options.sourceBundleDirectory,
    databasePath: options.databasePath,
    resetManifestPath: options.resetManifestPath,
    importReportPath: options.importReportPath,
    operatingMode: options.operatingMode,
    repositoryRoot:
      options.repositoryRoot ||
      path.resolve(__dirname, "..", "..", ".."),
    temporaryRoot: options.temporaryRoot || os.tmpdir(),
    fsModule,
  });
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function sha256File(filePath, fsModule) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let descriptor;
  try {
    descriptor = fsModule.openSync(filePath, "r");
    let bytesRead;
    do {
      bytesRead = fsModule.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null
      );
      if (bytesRead > 0) {
        digest.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
    return digest.digest("hex");
  } finally {
    if (descriptor !== undefined) {
      fsModule.closeSync(descriptor);
    }
  }
}

function captureVerifiedContinuityBaseline({
  databasePath,
  expectedDatabaseSha256,
  fsModule,
}) {
  let database;
  try {
    const before = sha256File(
      databasePath,
      fsModule
    );
    if (before !== expectedDatabaseSha256) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    database = openReadonlyDatabase({
      databasePath,
    });
    database.pragma("query_only = ON");
    const baseline =
      captureResetOriginalLeagueContinuityBaseline({
        database,
      });
    if (
      sha256File(databasePath, fsModule) !== before
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    return baseline;
  } catch (error) {
    if (
      error instanceof
      ResetImportVerificationArtifactError
    ) {
      throw error;
    }
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed,
      { cause: error }
    );
  } finally {
    if (database?.open) {
      database.close();
    }
  }
}

function canonicalFile(value) {
  return `${canonicalize(value)}\n`;
}

function readCanonicalJson(filePath, fsModule) {
  let raw;
  let parsed;
  try {
    raw = fsModule.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed,
      { cause: error }
    );
  }
  if (raw !== canonicalFile(parsed)) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  return parsed;
}

function exactSourceAgreement(
  sourceEvidence,
  verification
) {
  const verified = verification?.sourceBundle;
  if (
    !verified ||
    sourceEvidence.id !== verified.id ||
    sourceEvidence.checksum !== verified.checksum ||
    sourceEvidence.manifestVersion !==
      verified.manifestVersion ||
    sourceEvidence.capturedAtMs !==
      verified.capturedAtMs ||
    sourceEvidence.sourceCount !==
      verified.sourceCount ||
    sourceEvidence.fileCount !== verified.fileCount ||
    sourceEvidence.byteSize !== verified.byteSize
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
}

function descriptorEvidence(descriptor) {
  return Object.freeze({
    sha256: descriptorSha256(descriptor),
    descriptorVersion: descriptor.descriptorVersion,
    environment: descriptor.environment,
    resourceIds: descriptor.resourceIds,
    applicationAuthority:
      descriptor.applicationAuthority,
    sqliteApplicationAuthorityEnabled:
      descriptor.sqliteApplicationAuthorityEnabled,
    productionStorageAccessible:
      descriptor.productionStorageAccessible,
    productionSecretsAccessible:
      descriptor.productionSecretsAccessible,
  });
}

function buildPayload({
  continuityBaseline,
  descriptor,
  sourceEvidence,
  verification,
}) {
  const staging = descriptorEvidence(descriptor);
  if (
    verification?.environment !== "staging" ||
    verification?.status !== "verified" ||
    !DIGEST_PATTERN.test(
      verification?.verificationHash || ""
    ) ||
    staging.environment !== verification.environment ||
    verification?.checks?.applicationAuthority !==
      staging.applicationAuthority ||
    verification?.checks
      ?.sqliteApplicationAuthorityEnabled !==
      staging.sqliteApplicationAuthorityEnabled ||
    verification?.checks
      ?.productionStorageAccessible !==
      staging.productionStorageAccessible ||
    verification?.checks
      ?.productionSecretsAccessible !==
      staging.productionSecretsAccessible
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  assertResetOriginalLeagueContinuityBaseline(
    continuityBaseline
  );
  return Object.freeze({
    artifactPayloadVersion:
      RESET_IMPORT_ARTIFACT_VERSION,
    environment: "staging",
    continuityBaseline,
    stagingDescriptor: staging,
    sourceBundle: sourceEvidence,
    verification,
  });
}

function buildManifest({
  payloadRaw,
  payload,
}) {
  const evidenceSha256 = sha256(payloadRaw);
  return Object.freeze({
    artifactVersion: RESET_IMPORT_ARTIFACT_VERSION,
    environment: "staging",
    evidenceFile:
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE,
    evidenceBytes: Buffer.byteLength(
      payloadRaw,
      "utf8"
    ),
    evidenceSha256,
    importVerificationHash:
      payload.verification.verificationHash,
    verificationHash: evidenceSha256,
    stagingDescriptorSha256:
      payload.stagingDescriptor.sha256,
    databaseResourceId:
      payload.stagingDescriptor.resourceIds.database,
    sourceBundleId: payload.sourceBundle.id,
  });
}

function regularArtifactFile(filePath, fsModule) {
  const stat = fsModule.lstatSync(filePath);
  return stat.isFile() && !stat.isSymbolicLink();
}

function assertReaderPayload(payload) {
  assertJsonTree(payload);
  exactObject(payload, [
    "artifactPayloadVersion",
    "continuityBaseline",
    "environment",
    "stagingDescriptor",
    "sourceBundle",
    "verification",
  ]);
  if (
    payload.artifactPayloadVersion !==
      RESET_IMPORT_ARTIFACT_VERSION ||
    payload.environment !== "staging"
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  try {
    assertResetOriginalLeagueContinuityBaseline(
      payload.continuityBaseline
    );
  } catch (error) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed,
      { cause: error }
    );
  }

  const staging = exactObject(
    payload.stagingDescriptor,
    [
      "sha256",
      "descriptorVersion",
      "environment",
      "resourceIds",
      "applicationAuthority",
      "sqliteApplicationAuthorityEnabled",
      "productionStorageAccessible",
      "productionSecretsAccessible",
    ]
  );
  exactObject(staging.resourceIds, RESOURCE_KEYS);
  if (
    !DIGEST_PATTERN.test(staging.sha256 || "") ||
    staging.descriptorVersion !==
      STAGING_DESCRIPTOR_VERSION ||
    staging.environment !== "staging" ||
    Object.values(staging.resourceIds).some(
      (value) =>
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 500 ||
        value !== value.trim() ||
        !/staging/i.test(value) ||
        /(^|[^a-z])(prod|production)([^a-z]|$)/i.test(
          value
        )
    ) ||
    new Set(Object.values(staging.resourceIds)).size !==
      RESOURCE_KEYS.length ||
    staging.applicationAuthority !== "json" ||
    staging.sqliteApplicationAuthorityEnabled !== false ||
    staging.productionStorageAccessible !== false ||
    staging.productionSecretsAccessible !== false
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }

  const source = exactObject(payload.sourceBundle, [
    "id",
    "checksum",
    "manifestVersion",
    "capturedAtMs",
    "sourceCount",
    "fileCount",
    "byteSize",
    "sourceFiles",
  ]);
  if (
    !SOURCE_BUNDLE_ID_PATTERN.test(source.id || "") ||
    !DIGEST_PATTERN.test(source.checksum || "") ||
    source.manifestVersion !==
      SOURCE_BUNDLE_MANIFEST_VERSION ||
    !Array.isArray(source.sourceFiles) ||
    source.sourceFiles.length < 1 ||
    nonnegativeInteger(source.capturedAtMs) < 0 ||
    nonnegativeInteger(source.sourceCount) < 1 ||
    nonnegativeInteger(source.fileCount) !==
      source.sourceFiles.length
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  let byteSize = 0;
  let priorSortKey = null;
  const labels = new Set();
  const copiedPaths = new Set();
  for (const file of source.sourceFiles) {
    exactObject(file, [
      "sourceLabel",
      "copiedPath",
      "byteSize",
      "sha256",
    ]);
    if (
      !SOURCE_LABEL_PATTERN.test(
        file.sourceLabel || ""
      ) ||
      typeof file.copiedPath !== "string" ||
      !file.copiedPath.startsWith(
        `files/${file.sourceLabel}/`
      ) ||
      file.copiedPath.includes("\\") ||
      file.copiedPath
        .split("/")
        .some(
          (segment) =>
            segment === "" ||
            segment === "." ||
            segment === ".."
        ) ||
      !DIGEST_PATTERN.test(file.sha256 || "")
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    const sortKey =
      `${file.sourceLabel}\u0000${file.copiedPath}`;
    if (
      priorSortKey !== null &&
      priorSortKey >= sortKey
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    priorSortKey = sortKey;
    labels.add(file.sourceLabel);
    if (copiedPaths.has(file.copiedPath)) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    copiedPaths.add(file.copiedPath);
    byteSize += nonnegativeInteger(file.byteSize);
    if (!Number.isSafeInteger(byteSize)) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
  }
  if (
    labels.size !== source.sourceCount ||
    byteSize !== nonnegativeInteger(source.byteSize)
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }

  const verification = exactObject(
    payload.verification,
    [
      "verificationVersion",
      "status",
      "environment",
      "sourceBundle",
      "resetManifest",
      "database",
      "importReport",
      "reconciliation",
      "checks",
      "verificationHash",
    ]
  );
  if (
    verification.verificationVersion !== 1 ||
    verification.status !== "verified" ||
    verification.environment !== "staging" ||
    !DIGEST_PATTERN.test(
      verification.verificationHash || ""
    ) ||
    verificationHash(verification) !==
      verification.verificationHash ||
    verification.sourceBundle?.id !== source.id ||
    verification.sourceBundle?.checksum !==
      source.checksum ||
    verification.sourceBundle?.manifestVersion !==
      source.manifestVersion ||
    verification.sourceBundle?.capturedAtMs !==
      source.capturedAtMs ||
    verification.sourceBundle?.sourceCount !==
      source.sourceCount ||
    verification.sourceBundle?.fileCount !==
      source.fileCount ||
    verification.sourceBundle?.byteSize !==
      source.byteSize ||
    verification.checks?.applicationAuthority !==
      staging.applicationAuthority ||
    verification.checks
      ?.sqliteApplicationAuthorityEnabled !==
      staging.sqliteApplicationAuthorityEnabled ||
    verification.checks
      ?.productionStorageAccessible !==
      staging.productionStorageAccessible ||
    verification.checks
      ?.productionSecretsAccessible !==
      staging.productionSecretsAccessible
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed
    );
  }
  return payload;
}

function readResetImportVerificationArtifact(
  options
) {
  const required = [
    "artifactDirectory",
    "descriptorPath",
    "sourceBundleDirectory",
    "databasePath",
    "resetManifestPath",
    "importReportPath",
    "operatingMode",
  ];
  const optional = [
    "repositoryRoot",
    "fsModule",
  ];
  const allowed = new Set([...required, ...optional]);
  if (
    !isPlainObject(options) ||
    required.some(
      (key) => !Object.hasOwn(options, key)
    ) ||
    Object.keys(options).some(
      (key) => !allowed.has(key)
    ) ||
    required.some(
      (key) =>
        typeof options[key] !== "string" ||
        options[key].trim() === ""
    ) ||
    [
      "artifactDirectory",
      "descriptorPath",
      "sourceBundleDirectory",
      "databasePath",
      "resetManifestPath",
      "importReportPath",
    ].some((key) => !path.isAbsolute(options[key])) ||
    options.operatingMode !== "OFFSEASON_RESET" ||
    (
      options.repositoryRoot !== undefined &&
      (
        typeof options.repositoryRoot !== "string" ||
        options.repositoryRoot.trim() === ""
      )
    )
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid
    );
  }
  const fsModule = options.fsModule || fs;
  for (const method of [
    "closeSync",
    "existsSync",
    "lstatSync",
    "openSync",
    "readFileSync",
    "readSync",
    "readdirSync",
    "realpathSync",
    "statSync",
  ]) {
    if (typeof fsModule[method] !== "function") {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .argumentInvalid
      );
    }
  }
  if (
    typeof fsModule.realpathSync.native !==
    "function"
  ) {
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES.argumentInvalid
    );
  }
  try {
    const descriptor =
      loadAndValidateStagingDescriptor({
        descriptorPath: options.descriptorPath,
        fsModule,
      });
    const paths = validateVerificationPaths({
      descriptor,
      sourceBundleDirectory:
        options.sourceBundleDirectory,
      databasePath: options.databasePath,
      importReportPath: options.importReportPath,
      repositoryRoot:
        options.repositoryRoot ||
        path.resolve(__dirname, "..", "..", ".."),
      fsModule,
    });
    const reportRoot = fsModule.realpathSync(
      descriptor.paths.reports
    );
    const requestedArtifact = path.resolve(
      options.artifactDirectory
    );
    const requestedStat =
      fsModule.lstatSync(requestedArtifact);
    if (
      !requestedStat.isDirectory() ||
      requestedStat.isSymbolicLink()
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    const artifactDirectory =
      fsModule.realpathSync.native(
        requestedArtifact
      );
    if (
      path.relative(
        requestedArtifact,
        artifactDirectory
      ) !== "" ||
      path.relative(
        reportRoot,
        path.dirname(artifactDirectory)
      ) !== ""
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    const directoryStat =
      fsModule.lstatSync(artifactDirectory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink()
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    const names = fsModule
      .readdirSync(artifactDirectory)
      .sort();
    const expectedNames = [
      RESET_IMPORT_ARTIFACT_MANIFEST_FILE,
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE,
    ].sort();
    if (
      names.length !== expectedNames.length ||
      names.some(
        (name, index) => name !== expectedNames[index]
      )
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    const payloadPath = path.join(
      artifactDirectory,
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
    );
    const manifestPath = path.join(
      artifactDirectory,
      RESET_IMPORT_ARTIFACT_MANIFEST_FILE
    );
    if (
      !regularArtifactFile(payloadPath, fsModule) ||
      !regularArtifactFile(manifestPath, fsModule)
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    const payload = assertReaderPayload(
      readCanonicalJson(payloadPath, fsModule)
    );
    const manifest = readCanonicalJson(
      manifestPath,
      fsModule
    );
    const payloadRaw = canonicalFile(payload);
    const sourceManifestPath = path.join(
      paths.sourceBundleDirectory,
      SOURCE_BUNDLE_FILE_NAME
    );
    verifySourceBundle({
      bundleDirectory:
        paths.sourceBundleDirectory,
      fsModule,
    });
    const sourceBundleManifest = readCanonicalJson(
      sourceManifestPath,
      fsModule
    );
    const resetManifest =
      loadAndValidateResetManifest({
        manifestPath: options.resetManifestPath,
        operatingMode: options.operatingMode,
        sourceBundleManifestVersion:
          sourceBundleManifest.manifestVersion,
        fsModule,
      });
    const importReport = readCanonicalJson(
      paths.importReportPath,
      fsModule
    );
    const expectedDescriptor =
      descriptorEvidence(descriptor);
    const expectedSource =
      projectSanitizedSourceBundleEvidence(
        sourceBundleManifest
      );
    if (
      canonicalize(payload.stagingDescriptor) !==
        canonicalize(expectedDescriptor) ||
      canonicalize(payload.sourceBundle) !==
        canonicalize(expectedSource)
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    const migrationReportProjection =
      projectSucceededResetMigrationReport({
        sourceBundleManifest,
        resetManifest,
        importReport,
        verificationEvidence:
          payload.verification,
      });
    const expectedManifest = buildManifest({
      payloadRaw,
      payload,
    });
    if (
      canonicalize(manifest) !==
        canonicalize(expectedManifest) ||
      path.basename(artifactDirectory) !==
        `${RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX}${expectedManifest.verificationHash}`
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    deepFreeze(payload);
    deepFreeze(manifest);
    const result = Object.freeze({
      payload,
      manifest,
      migrationReportProjection,
      binding: Object.freeze({
        stagingDescriptorSha256:
          manifest.stagingDescriptorSha256,
        databaseResourceId:
          manifest.databaseResourceId,
        sourceBundleId: manifest.sourceBundleId,
        verificationHash:
          manifest.verificationHash,
      }),
    });
    VALIDATED_RESET_IMPORT_ARTIFACTS.add(result);
    return result;
  } catch (error) {
    if (
      error instanceof
      ResetImportVerificationArtifactError
    ) {
      throw error;
    }
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed,
      { cause: error }
    );
  }
}

function isValidatedResetImportVerificationArtifact(
  value
) {
  return (
    value !== null &&
    (typeof value === "object" ||
      typeof value === "function") &&
    VALIDATED_RESET_IMPORT_ARTIFACTS.has(value)
  );
}

function assertExactExistingArtifact({
  artifactDirectory,
  payloadRaw,
  manifestRaw,
  fsModule,
}) {
  try {
    const directoryStat =
      fsModule.lstatSync(artifactDirectory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink()
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .artifactConflict
      );
    }
    const names = fsModule
      .readdirSync(artifactDirectory)
      .sort();
    const expectedNames = [
      RESET_IMPORT_ARTIFACT_MANIFEST_FILE,
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE,
    ].sort();
    if (
      names.length !== expectedNames.length ||
      names.some(
        (name, index) => name !== expectedNames[index]
      )
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .artifactConflict
      );
    }
    const payloadPath = path.join(
      artifactDirectory,
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
    );
    const manifestPath = path.join(
      artifactDirectory,
      RESET_IMPORT_ARTIFACT_MANIFEST_FILE
    );
    if (
      !regularArtifactFile(payloadPath, fsModule) ||
      !regularArtifactFile(manifestPath, fsModule) ||
      fsModule.readFileSync(payloadPath, "utf8") !==
        payloadRaw ||
      fsModule.readFileSync(manifestPath, "utf8") !==
        manifestRaw
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .artifactConflict
      );
    }
  } catch (error) {
    if (
      error instanceof
      ResetImportVerificationArtifactError
    ) {
      throw error;
    }
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .artifactConflict,
      { cause: error }
    );
  }
}

function removeOwnedTemporary({
  reportRoot,
  temporaryDirectory,
  fsModule,
}) {
  const relative = path.relative(
    reportRoot,
    temporaryDirectory
  );
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return;
  }
  try {
    fsModule.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  } catch {
    // Preserve the publication failure.
  }
}

function sameFileIdentity(left, right) {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function exactPublicationLockRecord({
  value,
  verificationHash,
  nowMs,
}) {
  if (!isPlainObject(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [
    "createdAtMs",
    "hostname",
    "lockVersion",
    "nonce",
    "processId",
    "verificationHash",
  ].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) => key === expectedKeys[index]
    ) &&
    value.lockVersion ===
      RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_VERSION &&
    value.verificationHash === verificationHash &&
    UUID_PATTERN.test(value.nonce || "") &&
    Number.isSafeInteger(value.processId) &&
    value.processId > 0 &&
    typeof value.hostname === "string" &&
    value.hostname.length > 0 &&
    value.hostname.length <= 255 &&
    value.hostname === value.hostname.trim() &&
    value.hostname === value.hostname.toLowerCase() &&
    Number.isSafeInteger(value.createdAtMs) &&
    value.createdAtMs >= 0 &&
    value.createdAtMs <=
      nowMs +
        RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_GRACE_MS
  );
}

function publicationLockProcessIsDefinitelyDead(record) {
  if (
    record.hostname !==
    os.hostname().trim().toLowerCase()
  ) {
    return false;
  }
  try {
    process.kill(record.processId, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function inspectPublicationLock({
  lockPath,
  verificationHash,
  fsModule,
}) {
  let stat;
  try {
    stat = fsModule.lstatSync(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ status: "missing" });
    }
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .publicationFailed,
      { cause: error }
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !Number.isFinite(stat.mtimeMs) ||
    !Number.isSafeInteger(stat.size) ||
    stat.size >
      RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_MAX_BYTES
  ) {
    return Object.freeze({ status: "held" });
  }

  let raw;
  let record = null;
  try {
    raw = fsModule.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    const nowMs = Date.now();
    if (
      raw === canonicalFile(parsed) &&
      exactPublicationLockRecord({
        value: parsed,
        verificationHash,
        nowMs,
      })
    ) {
      record = parsed;
    }
  } catch {
    // An interrupted owner may leave an empty or partial record.
  }

  const nowMs = Date.now();
  const mtimeAgeMs = nowMs - stat.mtimeMs;
  let stale = false;
  if (record === null) {
    stale =
      mtimeAgeMs >=
      RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_GRACE_MS;
  } else {
    const sameHost =
      record.hostname ===
      os.hostname().trim().toLowerCase();
    const leaseExpired =
      !sameHost &&
      nowMs - record.createdAtMs >=
        RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_LEASE_MS &&
      mtimeAgeMs >=
        RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_LEASE_MS;
    const deadOwner =
      mtimeAgeMs >=
        RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_GRACE_MS &&
      publicationLockProcessIsDefinitelyDead(record);
    stale = leaseExpired || deadOwner;
  }
  return Object.freeze({
    status: stale ? "stale" : "held",
    raw,
    stat,
  });
}

function restoreUnexpectedQuarantinedLock({
  lockPath,
  quarantinePath,
  fsModule,
}) {
  try {
    fsModule.linkSync(quarantinePath, lockPath);
    fsModule.unlinkSync(quarantinePath);
  } catch {
    // Preserve the quarantine rather than replace a newer owner.
  }
}

function reclaimStalePublicationLock({
  lockPath,
  snapshot,
  fsModule,
}) {
  const quarantinePath =
    `${lockPath}.stale-${crypto.randomUUID()}`;
  try {
    fsModule.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .publicationFailed,
      { cause: error }
    );
  }

  try {
    const quarantinedStat =
      fsModule.lstatSync(quarantinePath);
    const quarantinedRaw = fsModule.readFileSync(
      quarantinePath,
      "utf8"
    );
    if (
      !quarantinedStat.isFile() ||
      quarantinedStat.isSymbolicLink() ||
      !sameFileIdentity(snapshot.stat, quarantinedStat) ||
      quarantinedRaw !== snapshot.raw
    ) {
      restoreUnexpectedQuarantinedLock({
        lockPath,
        quarantinePath,
        fsModule,
      });
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
    fsModule.unlinkSync(quarantinePath);
  } catch (error) {
    if (
      error instanceof
      ResetImportVerificationArtifactError
    ) {
      throw error;
    }
    restoreUnexpectedQuarantinedLock({
      lockPath,
      quarantinePath,
      fsModule,
    });
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .publicationFailed,
      { cause: error }
    );
  }
}

function releaseOwnedPublicationLock({
  lockPath,
  owner,
  fsModule,
}) {
  if (owner === null) {
    return;
  }
  try {
    fsModule.closeSync(owner.fileDescriptor);
  } catch {
    // Ownership is still verified independently below.
  }
  if (owner.identity === null) {
    return;
  }
  const quarantinePath =
    `${lockPath}.release-${crypto.randomUUID()}`;
  try {
    fsModule.renameSync(lockPath, quarantinePath);
  } catch {
    return;
  }
  try {
    const quarantinedStat =
      fsModule.lstatSync(quarantinePath);
    if (
      !quarantinedStat.isFile() ||
      quarantinedStat.isSymbolicLink() ||
      !sameFileIdentity(
        owner.identity,
        quarantinedStat
      )
    ) {
      restoreUnexpectedQuarantinedLock({
        lockPath,
        quarantinePath,
        fsModule,
      });
      return;
    }
    if (
      owner.recordComplete &&
      fsModule.readFileSync(
        quarantinePath,
        "utf8"
      ) !==
        owner.raw
    ) {
      restoreUnexpectedQuarantinedLock({
        lockPath,
        quarantinePath,
        fsModule,
      });
      return;
    }
    fsModule.unlinkSync(quarantinePath);
  } catch {
    restoreUnexpectedQuarantinedLock({
      lockPath,
      quarantinePath,
      fsModule,
    });
  }
}

function acquirePublicationLock({
  lockPath,
  artifactDirectory,
  payloadRaw,
  manifestRaw,
  verificationHash,
  fsModule,
}) {
  const record = Object.freeze({
    lockVersion:
      RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_VERSION,
    verificationHash,
    nonce: crypto.randomUUID(),
    processId: process.pid,
    hostname: os.hostname().trim().toLowerCase(),
    createdAtMs: Date.now(),
  });
  const raw = canonicalFile(record);

  for (
    let attempt = 0;
    attempt <
    RESET_IMPORT_ARTIFACT_PUBLICATION_LOCK_ATTEMPTS;
    attempt += 1
  ) {
    let fileDescriptor;
    try {
      fileDescriptor = fsModule.openSync(
        lockPath,
        "wx",
        0o600
      );
    } catch (error) {
      if (fsModule.existsSync(artifactDirectory)) {
        assertExactExistingArtifact({
          artifactDirectory,
          payloadRaw,
          manifestRaw,
          fsModule,
        });
        return Object.freeze({
          status: "replayed",
          owner: null,
        });
      }
      if (error?.code !== "EEXIST") {
        fail(
          RESET_IMPORT_ARTIFACT_ERROR_CODES
            .publicationFailed,
          { cause: error }
        );
      }
      const snapshot = inspectPublicationLock({
        lockPath,
        verificationHash,
        fsModule,
      });
      if (snapshot.status === "missing") {
        continue;
      }
      if (snapshot.status === "stale") {
        reclaimStalePublicationLock({
          lockPath,
          snapshot,
          fsModule,
        });
        continue;
      }
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed,
        { cause: error }
      );
    }

    const owner = {
      fileDescriptor,
      identity: null,
      raw,
      recordComplete: false,
    };
    try {
      owner.identity =
        fsModule.fstatSync(fileDescriptor);
      fsModule.writeFileSync(
        fileDescriptor,
        raw,
        "utf8"
      );
      fsModule.fsyncSync(fileDescriptor);
      owner.recordComplete = true;
      return Object.freeze({
        status: "acquired",
        owner: Object.freeze(owner),
      });
    } catch (error) {
      releaseOwnedPublicationLock({
        lockPath,
        owner,
        fsModule,
      });
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed,
        { cause: error }
      );
    }
  }

  fail(
    RESET_IMPORT_ARTIFACT_ERROR_CODES.publicationFailed
  );
}

function publishFiles({
  reportRoot,
  artifactDirectory,
  payloadRaw,
  manifestRaw,
  verificationHash,
  fsModule,
}) {
  if (fsModule.existsSync(artifactDirectory)) {
    assertExactExistingArtifact({
      artifactDirectory,
      payloadRaw,
      manifestRaw,
      fsModule,
    });
    return true;
  }

  const temporaryDirectory = path.join(
    reportRoot,
    `.${path.basename(
      artifactDirectory
    )}.building-${crypto.randomUUID()}`
  );
  const lockPath = path.join(
    reportRoot,
    `.${path.basename(
      artifactDirectory
    )}.publish.lock`
  );
  let ownsTemporary = false;
  let ownsFinal = false;
  let publicationLockOwner = null;
  try {
    fsModule.mkdirSync(temporaryDirectory, {
      mode: 0o700,
    });
    ownsTemporary = true;
    fsModule.writeFileSync(
      path.join(
        temporaryDirectory,
        RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
      ),
      payloadRaw,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }
    );
    fsModule.writeFileSync(
      path.join(
        temporaryDirectory,
        RESET_IMPORT_ARTIFACT_MANIFEST_FILE
      ),
      manifestRaw,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }
    );
    const lock = acquirePublicationLock({
      lockPath,
      artifactDirectory,
      payloadRaw,
      manifestRaw,
      verificationHash,
      fsModule,
    });
    if (lock.status === "replayed") {
      removeOwnedTemporary({
        reportRoot,
        temporaryDirectory,
        fsModule,
      });
      ownsTemporary = false;
      return true;
    }
    publicationLockOwner = lock.owner;
    if (fsModule.existsSync(artifactDirectory)) {
      assertExactExistingArtifact({
        artifactDirectory,
        payloadRaw,
        manifestRaw,
        fsModule,
      });
      removeOwnedTemporary({
        reportRoot,
        temporaryDirectory,
        fsModule,
      });
      ownsTemporary = false;
      return true;
    }
    fsModule.renameSync(
      temporaryDirectory,
      artifactDirectory
    );
    ownsTemporary = false;
    ownsFinal = true;
    assertExactExistingArtifact({
      artifactDirectory,
      payloadRaw,
      manifestRaw,
      fsModule,
    });
    ownsFinal = false;
    return false;
  } catch (error) {
    if (ownsTemporary) {
      removeOwnedTemporary({
        reportRoot,
        temporaryDirectory,
        fsModule,
      });
    }
    if (ownsFinal) {
      removeOwnedTemporary({
        reportRoot,
        temporaryDirectory: artifactDirectory,
        fsModule,
      });
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed,
        { cause: error }
      );
    }
    if (fsModule.existsSync(artifactDirectory)) {
      assertExactExistingArtifact({
        artifactDirectory,
        payloadRaw,
        manifestRaw,
        fsModule,
      });
      return true;
    }
    if (
      error instanceof
      ResetImportVerificationArtifactError
    ) {
      throw error;
    }
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .publicationFailed,
      { cause: error }
    );
  } finally {
    releaseOwnedPublicationLock({
      lockPath,
      owner: publicationLockOwner,
      fsModule,
    });
  }
}

function verifyInputs(normalized) {
  const verifyOptions = {
    descriptorPath: normalized.descriptorPath,
    sourceBundleDirectory:
      normalized.sourceBundleDirectory,
    databasePath: normalized.databasePath,
    resetManifestPath: normalized.resetManifestPath,
    importReportPath: normalized.importReportPath,
    operatingMode: normalized.operatingMode,
    repositoryRoot: normalized.repositoryRoot,
    temporaryRoot: normalized.temporaryRoot,
    fsModule: normalized.fsModule,
  };
  try {
    const descriptor =
      loadAndValidateStagingDescriptor({
        descriptorPath: normalized.descriptorPath,
        fsModule: normalized.fsModule,
      });
    validateVerificationPaths({
      descriptor,
      sourceBundleDirectory:
        normalized.sourceBundleDirectory,
      databasePath: normalized.databasePath,
      importReportPath: normalized.importReportPath,
      repositoryRoot: normalized.repositoryRoot,
      fsModule: normalized.fsModule,
    });
    const first = verifyStagingImport(verifyOptions);
    const sourceManifest = readCanonicalJson(
      path.join(
        normalized.sourceBundleDirectory,
        SOURCE_BUNDLE_FILE_NAME
      ),
      normalized.fsModule
    );
    const sourceEvidence =
      projectSanitizedSourceBundleEvidence(
        sourceManifest
      );
    exactSourceAgreement(sourceEvidence, first);

    const second = verifyStagingImport(verifyOptions);
    const confirmedDescriptor =
      loadAndValidateStagingDescriptor({
        descriptorPath: normalized.descriptorPath,
        fsModule: normalized.fsModule,
      });
    if (
      canonicalize(first) !== canonicalize(second) ||
      descriptorSha256(descriptor) !==
        descriptorSha256(confirmedDescriptor)
    ) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
    }
    exactSourceAgreement(sourceEvidence, second);
    const continuityBaseline =
      captureVerifiedContinuityBaseline({
        databasePath:
          normalized.databasePath,
        expectedDatabaseSha256:
          second.database.sha256,
        fsModule: normalized.fsModule,
      });
    return Object.freeze({
      continuityBaseline,
      descriptor: confirmedDescriptor,
      sourceEvidence,
      verification: second,
    });
  } catch (error) {
    if (
      error instanceof
      ResetImportVerificationArtifactError
    ) {
      throw error;
    }
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .verificationFailed,
      { cause: error }
    );
  }
}

function publishResetImportVerificationArtifact(
  options
) {
  const normalized = normalizeOptions(options);
  const verified = verifyInputs(normalized);
  const payload = buildPayload(verified);
  const payloadRaw = canonicalFile(payload);
  const manifest = buildManifest({
    payloadRaw,
    payload,
  });
  const manifestRaw = canonicalFile(manifest);
  let reportRoot;
  try {
    reportRoot = normalized.fsModule.realpathSync(
      verified.descriptor.paths.reports
    );
    const reportRootStat =
      normalized.fsModule.statSync(reportRoot);
    if (!reportRootStat.isDirectory()) {
      fail(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
    }
  } catch (error) {
    if (
      error instanceof
      ResetImportVerificationArtifactError
    ) {
      throw error;
    }
    fail(
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .publicationFailed,
      { cause: error }
    );
  }
  const artifactDirectory = path.join(
    reportRoot,
    `${RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX}${manifest.verificationHash}`
  );
  const replayed = publishFiles({
    reportRoot,
    artifactDirectory,
    payloadRaw,
    manifestRaw,
    verificationHash: manifest.verificationHash,
    fsModule: normalized.fsModule,
  });

  return Object.freeze({
    status: "published",
    replayed,
    artifactVersion: RESET_IMPORT_ARTIFACT_VERSION,
    artifactDirectory,
    evidenceBytes: manifest.evidenceBytes,
    evidenceSha256: manifest.evidenceSha256,
    verificationHash: manifest.verificationHash,
    stagingDescriptorSha256:
      manifest.stagingDescriptorSha256,
    databaseResourceId: manifest.databaseResourceId,
    sourceBundleId: manifest.sourceBundleId,
  });
}

module.exports = {
  RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX,
  RESET_IMPORT_ARTIFACT_ERROR_CODES,
  RESET_IMPORT_ARTIFACT_MANIFEST_FILE,
  RESET_IMPORT_ARTIFACT_PAYLOAD_FILE,
  RESET_IMPORT_ARTIFACT_VERSION,
  ResetImportVerificationArtifactError,
  isValidatedResetImportVerificationArtifact,
  publishResetImportVerificationArtifact,
  readResetImportVerificationArtifact,
};
