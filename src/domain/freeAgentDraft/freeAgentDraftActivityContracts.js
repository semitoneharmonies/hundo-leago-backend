"use strict";

const {
  CANONICAL_UUID_PATTERN,
} = require("./candidateCardPolicy");

const FREE_AGENT_DRAFT_ACTIVITY_CONTRACT_INVALID =
  "FREE_AGENT_DRAFT_ACTIVITY_CONTRACT_INVALID";

const FREE_AGENT_DRAFT_ACTIVITY_TYPES = Object.freeze([
  "free_agent_draft_started",
  "free_agent_draft_cards_published",
  "free_agent_draft_player_awarded",
  "free_agent_draft_restricted_created",
  "free_agent_draft_restricted_fallback_opened",
  "free_agent_draft_auction_no_winner",
  "free_agent_draft_player_invalid",
  "free_agent_draft_corrected",
  "free_agent_draft_week1_recovered",
  "free_agent_draft_completed",
  "fad_setup_exemption_authorized",
]);

const SETUP_EXEMPTION_METADATA_FIELDS = Object.freeze([
  "exemptionId",
  "migrationReportId",
  "seasonId",
]);

const ACTIVITY_CONTRACT_FIELDS = Object.freeze([
  "eventType",
  "metadata",
]);
const METADATA_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/u;
const FORBIDDEN_METADATA_KEY_PATTERN =
  /(?:authorization|candidatecardcontents|clientsecret|cookie|csrf|exception|helpmessag|password|path|rawresponse|session|sql|stack|token|url|uri)/iu;
const OPENING_PRIVATE_FIELD_PATTERN =
  /(?:bid|card|contract|help|offer|player|slot)/iu;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INVALID_UNICODE_SCALAR_PATTERN = /[\ud800-\udfff]/u;
const RAW_LOCATION_PATTERN =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:^|\s)\/(?:api|leagues?|teams?|free-agent-drafts?)\/|[A-Za-z]:\\|\\\\)/iu;
const MAXIMUM_METADATA_DEPTH = 8;
const MAXIMUM_METADATA_ENTRIES = 256;
const MAXIMUM_METADATA_ARRAY_LENGTH = 100;
const MAXIMUM_METADATA_STRING_CODE_POINTS = 500;
const MAXIMUM_METADATA_JSON_BYTES = 16_384;

class FreeAgentDraftActivityContractError extends Error {
  constructor(reasonCode) {
    super("The Free Agent Draft activity contract is invalid.");
    this.name = "FreeAgentDraftActivityContractError";
    this.code = FREE_AGENT_DRAFT_ACTIVITY_CONTRACT_INVALID;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new FreeAgentDraftActivityContractError(reasonCode);
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

function requireDataProperties(value, reasonCode) {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(reasonCode);
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      name
    );
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      fail(reasonCode);
    }
  }
}

function requireExactObject(value, fields, reasonCode) {
  if (!isPlainObject(value)) fail(reasonCode);
  requireDataProperties(value, reasonCode);
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    fail(reasonCode);
  }
}

function requireExactArray(value, reasonCode) {
  if (
    !Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(reasonCode);
  }
  const propertyNames = Object.getOwnPropertyNames(value);
  if (
    propertyNames.length !== value.length + 1 ||
    !propertyNames.includes("length")
  ) {
    fail(reasonCode);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index)
    );
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      fail(reasonCode);
    }
  }
}

function validateFreeAgentDraftActivityType(value) {
  if (!FREE_AGENT_DRAFT_ACTIVITY_TYPES.includes(value)) {
    fail("activity_type_invalid");
  }
  return value;
}

function safeString(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    Array.from(value).length >
      MAXIMUM_METADATA_STRING_CODE_POINTS ||
    FORBIDDEN_TEXT_PATTERN.test(value) ||
    INVALID_UNICODE_SCALAR_PATTERN.test(value) ||
    RAW_LOCATION_PATTERN.test(value)
  ) {
    fail("activity_metadata_string_invalid");
  }
  return value;
}

function canonicalMetadataValue(
  value,
  state,
  depth
) {
  if (depth > MAXIMUM_METADATA_DEPTH) {
    fail("activity_metadata_depth_invalid");
  }
  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return safeString(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("activity_metadata_number_invalid");
    }
    return value;
  }
  if (typeof value !== "object") {
    fail("activity_metadata_value_invalid");
  }
  if (state.ancestors.has(value)) {
    fail("activity_metadata_cycle_invalid");
  }
    state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      requireExactArray(
        value,
        "activity_metadata_array_invalid"
      );
      if (
        value.length > MAXIMUM_METADATA_ARRAY_LENGTH
      ) {
        fail("activity_metadata_array_invalid");
      }
      state.entries += value.length;
      if (state.entries > MAXIMUM_METADATA_ENTRIES) {
        fail("activity_metadata_size_invalid");
      }
      return Object.freeze(
        value.map((entry) =>
          canonicalMetadataValue(
            entry,
            state,
            depth + 1
          )
        )
      );
    }
    if (!isPlainObject(value)) {
      fail("activity_metadata_object_invalid");
    }
    requireDataProperties(
      value,
      "activity_metadata_object_invalid"
    );
    const fields = Object.getOwnPropertyNames(value).sort();
    state.entries += fields.length;
    if (state.entries > MAXIMUM_METADATA_ENTRIES) {
      fail("activity_metadata_size_invalid");
    }
    const result = {};
    for (const field of fields) {
      if (
        !METADATA_KEY_PATTERN.test(field) ||
        FORBIDDEN_METADATA_KEY_PATTERN.test(field) ||
        (state.eventType ===
          "free_agent_draft_started" &&
          OPENING_PRIVATE_FIELD_PATTERN.test(field))
      ) {
        fail("activity_metadata_field_invalid");
      }
      result[field] = canonicalMetadataValue(
        value[field],
        state,
        depth + 1
      );
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

function validateFreeAgentDraftActivityMetadata(
  eventType,
  metadata
) {
  validateFreeAgentDraftActivityType(eventType);
  if (!isPlainObject(metadata)) {
    fail("activity_metadata_object_invalid");
  }
  if (eventType === "fad_setup_exemption_authorized") {
    requireExactObject(
      metadata,
      SETUP_EXEMPTION_METADATA_FIELDS,
      "activity_metadata_fields_invalid"
    );
    for (const field of SETUP_EXEMPTION_METADATA_FIELDS) {
      if (!CANONICAL_UUID_PATTERN.test(metadata[field] || "")) {
        fail("activity_metadata_id_invalid");
      }
    }
  }
  const canonical = canonicalMetadataValue(
    metadata,
    {
      ancestors: new Set(),
      entries: 0,
      eventType,
    },
    0
  );
  const serialized = JSON.stringify(canonical);
  if (
    Buffer.byteLength(serialized, "utf8") >
    MAXIMUM_METADATA_JSON_BYTES
  ) {
    fail("activity_metadata_size_invalid");
  }
  return canonical;
}

function createFreeAgentDraftActivityContract(
  input = {}
) {
  requireExactObject(
    input,
    ACTIVITY_CONTRACT_FIELDS,
    "activity_contract_fields_invalid"
  );
  const eventType = validateFreeAgentDraftActivityType(
    input.eventType
  );
  return Object.freeze({
    eventType,
    metadata: validateFreeAgentDraftActivityMetadata(
      eventType,
      input.metadata
    ),
  });
}

module.exports = {
  FREE_AGENT_DRAFT_ACTIVITY_CONTRACT_INVALID,
  FREE_AGENT_DRAFT_ACTIVITY_TYPES,
  MAXIMUM_METADATA_ARRAY_LENGTH,
  MAXIMUM_METADATA_DEPTH,
  MAXIMUM_METADATA_ENTRIES,
  MAXIMUM_METADATA_JSON_BYTES,
  MAXIMUM_METADATA_STRING_CODE_POINTS,
  FreeAgentDraftActivityContractError,
  createFreeAgentDraftActivityContract,
  validateFreeAgentDraftActivityMetadata,
  validateFreeAgentDraftActivityType,
};
