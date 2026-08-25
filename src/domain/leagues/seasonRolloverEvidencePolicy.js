const {
  sha256Hex,
} = require("../shared/sha256");

const CANONICAL_JSON_V1_SCHEMA_VERSION = 1;
const SEASON_ROLLOVER_SOURCE_READINESS_DOMAIN =
  "hundo-leago.season-rollover-source-readiness";
const SEASON_ROLLOVER_ITEM_DOMAIN =
  "hundo-leago.season-rollover-item";
const SEASON_ROLLOVER_MANIFEST_DOMAIN =
  "hundo-leago.season-rollover-manifest";

class CanonicalJsonV1Error extends TypeError {
  constructor(reason) {
    super("The value cannot be encoded as canonical-json-v1.");
    this.name = "CanonicalJsonV1Error";
    this.code = "CANONICAL_JSON_V1_INVALID";
    this.reason = reason;
  }
}

function invalid(reason) {
  throw new CanonicalJsonV1Error(reason);
}

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        !Number.isInteger(nextCodeUnit) ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        invalid("invalid_unicode_scalar");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalid("invalid_unicode_scalar");
    }
  }
}

function nextScalar(value, index) {
  const scalar = value.codePointAt(index);
  return Object.freeze({
    scalar,
    nextIndex: index + (scalar > 0xffff ? 2 : 1),
  });
}

function compareUnicodeScalarStrings(left, right) {
  let leftIndex = 0;
  let rightIndex = 0;
  while (
    leftIndex < left.length &&
    rightIndex < right.length
  ) {
    const leftScalar = nextScalar(left, leftIndex);
    const rightScalar = nextScalar(right, rightIndex);
    if (leftScalar.scalar !== rightScalar.scalar) {
      return leftScalar.scalar - rightScalar.scalar;
    }
    leftIndex = leftScalar.nextIndex;
    rightIndex = rightScalar.nextIndex;
  }
  if (leftIndex < left.length) {
    return 1;
  }
  if (rightIndex < right.length) {
    return -1;
  }
  return 0;
}

function assertNoSymbolProperties(value) {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid("symbol_property");
  }
}

function serializeArray(value, ancestors) {
  assertNoSymbolProperties(value);
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    !names.includes("length")
  ) {
    invalid("noncanonical_array_property");
  }
  const items = [];
  ancestors.add(value);
  try {
    for (let index = 0; index < value.length; index += 1) {
      const name = String(index);
      if (!Object.prototype.hasOwnProperty.call(value, name)) {
        invalid("sparse_array");
      }
      const descriptor =
        Object.getOwnPropertyDescriptor(value, name);
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(
          descriptor,
          "value"
        )
      ) {
        invalid("noncanonical_array_element");
      }
      items.push(serializeValue(descriptor.value, ancestors));
    }
  } finally {
    ancestors.delete(value);
  }
  return `[${items.join(",")}]`;
}

function serializeObject(value, ancestors) {
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    invalid("non_plain_object");
  }
  assertNoSymbolProperties(value);
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    assertUnicodeScalarString(name);
    const descriptor =
      Object.getOwnPropertyDescriptor(value, name);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      invalid("noncanonical_object_property");
    }
  }
  names.sort(compareUnicodeScalarStrings);
  const entries = [];
  ancestors.add(value);
  try {
    for (const name of names) {
      const descriptor =
        Object.getOwnPropertyDescriptor(value, name);
      entries.push(
        `${JSON.stringify(name)}:${serializeValue(
          descriptor.value,
          ancestors
        )}`
      );
    }
  } finally {
    ancestors.delete(value);
  }
  return `{${entries.join(",")}}`;
}

function serializeValue(value, ancestors) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (
      !Number.isSafeInteger(value) ||
      Object.is(value, -0)
    ) {
      invalid("non_safe_integer");
    }
    return String(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    invalid("unsupported_type");
  }
  if (ancestors.has(value)) {
    invalid("cyclic_value");
  }
  if (Array.isArray(value)) {
    return serializeArray(value, ancestors);
  }
  return serializeObject(value, ancestors);
}

function serializeCanonicalJsonV1(value) {
  return serializeValue(value, new WeakSet());
}

function parseCanonicalJsonV1(serialized) {
  if (typeof serialized !== "string") {
    invalid("serialized_value_not_string");
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    invalid("invalid_json_text");
  }
  if (serializeCanonicalJsonV1(value) !== serialized) {
    invalid("noncanonical_json_text");
  }
  return value;
}

function hashCanonicalJsonV1(value) {
  return sha256Hex(serializeCanonicalJsonV1(value));
}

function serializeSeasonRolloverSourceReadiness(
  sourceReadiness
) {
  return serializeCanonicalJsonV1(sourceReadiness);
}

function hashSeasonRolloverSourceReadiness(
  sourceReadiness
) {
  return hashCanonicalJsonV1({
    domain:
      SEASON_ROLLOVER_SOURCE_READINESS_DOMAIN,
    schemaVersion: CANONICAL_JSON_V1_SCHEMA_VERSION,
    sourceReadiness,
  });
}

function hashSeasonRolloverItem(item) {
  return hashCanonicalJsonV1({
    domain: SEASON_ROLLOVER_ITEM_DOMAIN,
    schemaVersion: CANONICAL_JSON_V1_SCHEMA_VERSION,
    item,
  });
}

function hashSeasonRolloverManifest(manifest) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.prototype.hasOwnProperty.call(
      manifest,
      "domain"
    ) ||
    Object.prototype.hasOwnProperty.call(
      manifest,
      "schemaVersion"
    )
  ) {
    invalid("manifest_projection_invalid");
  }
  serializeCanonicalJsonV1(manifest);
  return hashCanonicalJsonV1({
    ...manifest,
    domain: SEASON_ROLLOVER_MANIFEST_DOMAIN,
    schemaVersion: CANONICAL_JSON_V1_SCHEMA_VERSION,
  });
}

module.exports = {
  CANONICAL_JSON_V1_SCHEMA_VERSION,
  CanonicalJsonV1Error,
  SEASON_ROLLOVER_ITEM_DOMAIN,
  SEASON_ROLLOVER_MANIFEST_DOMAIN,
  SEASON_ROLLOVER_SOURCE_READINESS_DOMAIN,
  compareUnicodeScalarStrings,
  hashCanonicalJsonV1,
  hashSeasonRolloverItem,
  hashSeasonRolloverManifest,
  hashSeasonRolloverSourceReadiness,
  parseCanonicalJsonV1,
  serializeCanonicalJsonV1,
  serializeSeasonRolloverSourceReadiness,
};
