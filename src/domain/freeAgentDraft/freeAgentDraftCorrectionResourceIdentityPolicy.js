"use strict";

const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../leagues/seasonRolloverEvidencePolicy"
);

const FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_DOMAIN =
  "hundo-leago.fad-allocation-correction-resource-identity";
const FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_SCHEMA_VERSION =
  1;
const FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_CODE =
  "FAD_ALLOCATION_CORRECTION_RESOURCE_IDENTITY_INVALID";
const RESOURCE_TYPES = Object.freeze([
  "contract",
  "ownership",
]);
const INPUT_FIELDS = Object.freeze([
  "acceptedFromAllocationVersion",
  "allocationId",
  "fadId",
  "leagueId",
  "resourceType",
  "targetTeamId",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class FreeAgentDraftCorrectionResourceIdentityPolicyError extends Error {
  constructor(reasonCode) {
    super(
      "The FAD allocation-correction resource identity input is invalid."
    );
    this.name =
      "FreeAgentDraftCorrectionResourceIdentityPolicyError";
    this.code =
      FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_CODE;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new FreeAgentDraftCorrectionResourceIdentityPolicyError(
    reasonCode
  );
}

function exactObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).sort().join("|") !==
      [...INPUT_FIELDS].sort().join("|")
  ) {
    fail("identity_fields_invalid");
  }
}

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function freeAgentDraftCorrectionResourceIdentityProjection(
  input = {}
) {
  exactObject(input);
  if (
    !Number.isSafeInteger(
      input.acceptedFromAllocationVersion
    ) ||
    input.acceptedFromAllocationVersion < 1
  ) {
    fail("allocation_version_invalid");
  }
  if (!RESOURCE_TYPES.includes(input.resourceType)) {
    fail("resource_type_invalid");
  }
  return Object.freeze({
    domain:
      FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_DOMAIN,
    schemaVersion:
      FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_SCHEMA_VERSION,
    leagueId: stableId(
      input.leagueId,
      "league_id_invalid"
    ),
    fadId: stableId(input.fadId, "fad_id_invalid"),
    allocationId: stableId(
      input.allocationId,
      "allocation_id_invalid"
    ),
    acceptedFromAllocationVersion:
      input.acceptedFromAllocationVersion,
    targetTeamId: stableId(
      input.targetTeamId,
      "target_team_id_invalid"
    ),
    resourceType: input.resourceType,
  });
}

function serializeFreeAgentDraftCorrectionResourceIdentity(
  input
) {
  return serializeCanonicalJsonV1(
    freeAgentDraftCorrectionResourceIdentityProjection(input)
  );
}

function hashFreeAgentDraftCorrectionResourceIdentity(input) {
  return hashCanonicalJsonV1(
    freeAgentDraftCorrectionResourceIdentityProjection(input)
  );
}

function deriveFreeAgentDraftCorrectionResourceId(input) {
  const bytes = Buffer.from(
    hashFreeAgentDraftCorrectionResourceIdentity(input).slice(
      0,
      32
    ),
    "hex"
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `${hex.slice(12, 16)}-${hex.slice(16, 20)}-` +
    hex.slice(20, 32)
  );
}

module.exports = {
  FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_CODE,
  FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_DOMAIN,
  FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_SCHEMA_VERSION,
  RESOURCE_TYPES,
  FreeAgentDraftCorrectionResourceIdentityPolicyError,
  deriveFreeAgentDraftCorrectionResourceId,
  freeAgentDraftCorrectionResourceIdentityProjection,
  hashFreeAgentDraftCorrectionResourceIdentity,
  serializeFreeAgentDraftCorrectionResourceIdentity,
};
