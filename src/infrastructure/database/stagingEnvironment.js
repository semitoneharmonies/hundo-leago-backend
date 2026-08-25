const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STAGING_DESCRIPTOR_VERSION = 1;
const STAGING_DESCRIPTOR_ERROR_CODES = Object.freeze({
  argumentInvalid: "STAGING_DESCRIPTOR_ARGUMENT_INVALID",
  readFailed: "STAGING_DESCRIPTOR_READ_FAILED",
  noncanonical: "STAGING_DESCRIPTOR_NONCANONICAL",
  shapeInvalid: "STAGING_DESCRIPTOR_SHAPE_INVALID",
  isolationInvalid: "STAGING_DESCRIPTOR_ISOLATION_INVALID",
  pathUnsafe: "STAGING_DESCRIPTOR_PATH_UNSAFE",
  authorityUnsafe: "STAGING_DESCRIPTOR_AUTHORITY_UNSAFE",
});

const ROOT_KEYS = Object.freeze([
  "descriptorVersion",
  "environment",
  "resourceIds",
  "paths",
  "backupNamespace",
  "secretScope",
  "secretReferences",
  "applicationAuthority",
  "sqliteApplicationAuthorityEnabled",
  "productionStorageAccessible",
  "productionSecretsAccessible",
]);
const RESOURCE_KEYS = Object.freeze([
  "service",
  "disk",
  "database",
  "sourceBundle",
  "reports",
  "backups",
]);
const PATH_KEYS = Object.freeze([
  "persistentRoot",
  "database",
  "sourceBundles",
  "reports",
  "backups",
]);
const SECRET_REFERENCES = Object.freeze([
  "AUDIT_METADATA_SECRET",
  "BACKUP_ENCRYPTION_KEY",
  "RATE_LIMIT_KEY_SECRET",
]);
const FORBIDDEN_VALUE_PATTERN = /(^|[^a-z])(prod|production)([^a-z]|$)/i;

class StagingDescriptorError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StagingDescriptorError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new StagingDescriptorError(code, message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length &&
    actual.every((key, index) => key === required[index]);
}

function isBoundedText(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    value === value.trim();
}

function cloneAndFreeze(value) {
  const clone = JSON.parse(JSON.stringify(value));
  function freeze(item) {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(clone);
}

function serializeStagingDescriptor(descriptor) {
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

function descriptorSha256(descriptor) {
  return crypto
    .createHash("sha256")
    .update(serializeStagingDescriptor(descriptor))
    .digest("hex");
}

function assertShape(descriptor) {
  if (
    !hasExactKeys(descriptor, ROOT_KEYS) ||
    descriptor.descriptorVersion !== STAGING_DESCRIPTOR_VERSION ||
    descriptor.environment !== "staging" ||
    !hasExactKeys(descriptor.resourceIds, RESOURCE_KEYS) ||
    !hasExactKeys(descriptor.paths, PATH_KEYS) ||
    !Object.values(descriptor.resourceIds).every(isBoundedText) ||
    !Object.values(descriptor.paths).every(isBoundedText) ||
    !isBoundedText(descriptor.backupNamespace) ||
    descriptor.secretScope !== "staging" ||
    !Array.isArray(descriptor.secretReferences) ||
    descriptor.secretReferences.length !== SECRET_REFERENCES.length ||
    !descriptor.secretReferences.every(isBoundedText) ||
    new Set(descriptor.secretReferences).size !==
      descriptor.secretReferences.length ||
    typeof descriptor.applicationAuthority !== "string" ||
    typeof descriptor.sqliteApplicationAuthorityEnabled !== "boolean" ||
    typeof descriptor.productionStorageAccessible !== "boolean" ||
    typeof descriptor.productionSecretsAccessible !== "boolean"
  ) {
    fail(
      STAGING_DESCRIPTOR_ERROR_CODES.shapeInvalid,
      "The staging descriptor has an invalid or unsupported shape."
    );
  }
}

function assertIsolation(descriptor) {
  const resourceIds = Object.values(descriptor.resourceIds);
  const stringValues = [
    ...resourceIds,
    ...Object.values(descriptor.paths),
    descriptor.backupNamespace,
    descriptor.secretScope,
    ...descriptor.secretReferences,
    descriptor.applicationAuthority,
  ];
  if (
    new Set(resourceIds).size !== resourceIds.length ||
    resourceIds.some((value) => !/staging/i.test(value)) ||
    !/staging/i.test(descriptor.backupNamespace) ||
    stringValues.some((value) => FORBIDDEN_VALUE_PATTERN.test(value)) ||
    descriptor.secretReferences.some(
      (value, index) => value !== SECRET_REFERENCES[index]
    )
  ) {
    fail(
      STAGING_DESCRIPTOR_ERROR_CODES.isolationInvalid,
      "Staging resources must be distinct, staging-scoped, and free of production references."
    );
  }
}

function selectPathApi(value) {
  if (path.win32.isAbsolute(value)) return path.win32;
  if (path.posix.isAbsolute(value)) return path.posix;
  return null;
}

function normalizedPath(value, api) {
  const normalized = api.normalize(value);
  return api === path.win32 ? normalized.toLowerCase() : normalized;
}

function isStrictChild(root, candidate, api) {
  const relative = api.relative(root, candidate);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative);
}

function assertSafePaths(descriptor) {
  const values = Object.values(descriptor.paths);
  const rootApi = selectPathApi(descriptor.paths.persistentRoot);
  if (!rootApi || values.some((value) => selectPathApi(value) !== rootApi)) {
    fail(
      STAGING_DESCRIPTOR_ERROR_CODES.pathUnsafe,
      "Every staging path must be absolute and use one path style."
    );
  }

  const normalized = Object.fromEntries(
    Object.entries(descriptor.paths).map(([key, value]) => [
      key,
      normalizedPath(value, rootApi),
    ])
  );
  const childKeys = PATH_KEYS.filter((key) => key !== "persistentRoot");
  if (
    new Set(Object.values(normalized)).size !== PATH_KEYS.length ||
    !/staging/i.test(normalized.persistentRoot) ||
    childKeys.some(
      (key) => !isStrictChild(
        normalized.persistentRoot,
        normalized[key],
        rootApi
      )
    ) ||
    !/\.sqlite3$/i.test(normalized.database)
  ) {
    fail(
      STAGING_DESCRIPTOR_ERROR_CODES.pathUnsafe,
      "Staging paths must be distinct children of one staging root."
    );
  }
}

function assertAuthorityBoundary(descriptor) {
  if (
    descriptor.applicationAuthority !== "json" ||
    descriptor.sqliteApplicationAuthorityEnabled !== false ||
    descriptor.productionStorageAccessible !== false ||
    descriptor.productionSecretsAccessible !== false
  ) {
    fail(
      STAGING_DESCRIPTOR_ERROR_CODES.authorityUnsafe,
      "The descriptor must keep JSON authoritative, SQLite disabled for application traffic, and production inaccessible."
    );
  }
}

function validateStagingDescriptor(descriptor) {
  assertShape(descriptor);
  assertIsolation(descriptor);
  assertSafePaths(descriptor);
  assertAuthorityBoundary(descriptor);
  return cloneAndFreeze(descriptor);
}

function loadAndValidateStagingDescriptor({
  descriptorPath,
  fsModule = fs,
} = {}) {
  if (
    !isBoundedText(descriptorPath) ||
    !fsModule ||
    typeof fsModule.readFileSync !== "function"
  ) {
    fail(
      STAGING_DESCRIPTOR_ERROR_CODES.argumentInvalid,
      "An explicit staging-descriptor path is required."
    );
  }

  let raw;
  let parsed;
  try {
    raw = fsModule.readFileSync(descriptorPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      STAGING_DESCRIPTOR_ERROR_CODES.readFailed,
      "The staging descriptor could not be read and parsed.",
      { cause: error }
    );
  }
  if (raw !== serializeStagingDescriptor(parsed)) {
    fail(
      STAGING_DESCRIPTOR_ERROR_CODES.noncanonical,
      "The staging descriptor file is not canonically serialized."
    );
  }
  return validateStagingDescriptor(parsed);
}

module.exports = {
  RESOURCE_KEYS,
  STAGING_DESCRIPTOR_ERROR_CODES,
  STAGING_DESCRIPTOR_VERSION,
  StagingDescriptorError,
  descriptorSha256,
  loadAndValidateStagingDescriptor,
  serializeStagingDescriptor,
  validateStagingDescriptor,
};
