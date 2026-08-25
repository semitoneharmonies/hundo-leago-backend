const crypto = require("node:crypto");

const {
  canonicalize,
} = require("./sourceInventory");

const HUNDO_LEAGO_MIGRATION_NAMESPACE =
  "8dc8b3a0-4c15-5f91-9b6d-20ac79c24731";
const DETERMINISTIC_IDENTITY_VERSION = 1;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UUID_HEX_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const DETERMINISTIC_ID_ERROR_CODES = Object.freeze({
  argumentInvalid: "TRANSFORM_ARGUMENT_INVALID",
});

class DeterministicIdError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeterministicIdError";
    this.code = code;
  }
}

function deterministicIdError(message) {
  return new DeterministicIdError(
    DETERMINISTIC_ID_ERROR_CODES.argumentInvalid,
    message
  );
}

function uuidToBytes(uuid) {
  if (
    typeof uuid !== "string" ||
    !UUID_HEX_PATTERN.test(uuid)
  ) {
    throw deterministicIdError(
      "The deterministic-ID namespace must be a canonical UUID."
    );
  }
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function bytesToUuid(bytes) {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function assertTuplePart(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value.trim() !== value
  ) {
    throw deterministicIdError(
      `${name} must be a non-empty bounded canonical string.`
    );
  }
}

function canonicalIdentityName({
  sourceBundleType,
  sourceCollection,
  sourceKey,
  targetTable,
} = {}) {
  assertTuplePart(sourceBundleType, "sourceBundleType");
  assertTuplePart(sourceCollection, "sourceCollection");
  assertTuplePart(sourceKey, "sourceKey");
  assertTuplePart(targetTable, "targetTable");

  return canonicalize([
    DETERMINISTIC_IDENTITY_VERSION,
    sourceBundleType,
    sourceCollection,
    sourceKey,
    targetTable,
  ]);
}

function uuidV5(name, namespace) {
  if (typeof name !== "string" || name.length === 0) {
    throw deterministicIdError(
      "The deterministic-ID name must be a non-empty string."
    );
  }
  const digest = crypto
    .createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function createDeterministicId(identity) {
  return uuidV5(
    canonicalIdentityName(identity),
    HUNDO_LEAGO_MIGRATION_NAMESPACE
  );
}

function createDeterministicMapping(identity) {
  const targetId = createDeterministicId(identity);
  return Object.freeze({
    sourceCollection: identity.sourceCollection,
    sourceKey: identity.sourceKey,
    targetTable: identity.targetTable,
    targetId,
    mappingMethod: "uuid_v5_canonical_source_identity",
    mappingConfidence: "exact",
  });
}

module.exports = {
  DETERMINISTIC_IDENTITY_VERSION,
  DETERMINISTIC_ID_ERROR_CODES,
  HUNDO_LEAGO_MIGRATION_NAMESPACE,
  UUID_PATTERN,
  DeterministicIdError,
  canonicalIdentityName,
  createDeterministicId,
  createDeterministicMapping,
  uuidV5,
};
