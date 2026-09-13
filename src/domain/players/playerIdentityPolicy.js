const MAXIMUM_PLAYER_NAME_CODE_POINTS = 200;
const MAXIMUM_PROVIDER_IDENTIFIER_CODE_POINTS = 500;
const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const PLAYER_STATUSES = new Set(["active", "historical"]);

const PLAYER_IDENTITY_CODES = Object.freeze({
  inputInvalid: "PLAYER_IDENTITY_INPUT_INVALID",
  playerIdInvalid: "PLAYER_ID_INVALID",
  playerNameInvalid: "PLAYER_NAME_INVALID",
  birthDateInvalid: "PLAYER_BIRTH_DATE_INVALID",
  playerStatusInvalid: "PLAYER_STATUS_INVALID",
  timestampInvalid: "PLAYER_TIMESTAMP_INVALID",
  providerInvalid: "PLAYER_PROVIDER_INVALID",
  externalIdInvalid: "PLAYER_EXTERNAL_ID_INVALID",
});

class PlayerIdentityPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted player identity is invalid.");
    this.name = "PlayerIdentityPolicyError";
    this.code = PLAYER_IDENTITY_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new PlayerIdentityPolicyError(reasonCode);
}

function codePointLength(value) {
  return Array.from(value).length;
}

function assertExactObject(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(PLAYER_IDENTITY_CODES.inputInvalid);
  }

  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(PLAYER_IDENTITY_CODES.inputInvalid);
  }
}

function assertStablePlayerId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(PLAYER_IDENTITY_CODES.playerIdInvalid);
  }
  return value;
}

function assertCanonicalText(
  value,
  reasonCode,
  maximumCodePoints
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    codePointLength(value) > maximumCodePoints ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function assertBirthDate(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    fail(PLAYER_IDENTITY_CODES.birthDateInvalid);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    fail(PLAYER_IDENTITY_CODES.birthDateInvalid);
  }
  return value;
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(PLAYER_IDENTITY_CODES.timestampInvalid);
  }
  return value;
}

function createGlobalPlayerRecord(input) {
  assertExactObject(input, [
    "id",
    "firstName",
    "lastName",
    "fullName",
    "birthDate",
    "status",
    "createdAtMs",
    "updatedAtMs",
  ]);

  const createdAtMs = assertTimestamp(input.createdAtMs);
  const updatedAtMs = assertTimestamp(input.updatedAtMs);
  if (updatedAtMs < createdAtMs) {
    fail(PLAYER_IDENTITY_CODES.timestampInvalid);
  }
  if (!PLAYER_STATUSES.has(input.status)) {
    fail(PLAYER_IDENTITY_CODES.playerStatusInvalid);
  }

  return Object.freeze({
    id: assertStablePlayerId(input.id),
    first_name: assertCanonicalText(
      input.firstName,
      PLAYER_IDENTITY_CODES.playerNameInvalid,
      MAXIMUM_PLAYER_NAME_CODE_POINTS
    ),
    last_name: assertCanonicalText(
      input.lastName,
      PLAYER_IDENTITY_CODES.playerNameInvalid,
      MAXIMUM_PLAYER_NAME_CODE_POINTS
    ),
    full_name: assertCanonicalText(
      input.fullName,
      PLAYER_IDENTITY_CODES.playerNameInvalid,
      MAXIMUM_PLAYER_NAME_CODE_POINTS
    ),
    birth_date: assertBirthDate(input.birthDate),
    status: input.status,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    version: 1,
  });
}

function createPlayerExternalIdRecord(input) {
  assertExactObject(input, [
    "id",
    "playerId",
    "provider",
    "externalValue",
    "createdAtMs",
  ]);

  return Object.freeze({
    id: assertStablePlayerId(input.id),
    player_id: assertStablePlayerId(input.playerId),
    provider: assertCanonicalText(
      input.provider,
      PLAYER_IDENTITY_CODES.providerInvalid,
      MAXIMUM_PROVIDER_IDENTIFIER_CODE_POINTS
    ),
    external_value: assertCanonicalText(
      input.externalValue,
      PLAYER_IDENTITY_CODES.externalIdInvalid,
      MAXIMUM_PROVIDER_IDENTIFIER_CODE_POINTS
    ),
    created_at_ms: assertTimestamp(input.createdAtMs),
  });
}

function validateExternalIdentifierLookup(input) {
  assertExactObject(input, ["provider", "externalValue"]);
  return Object.freeze({
    provider: assertCanonicalText(
      input.provider,
      PLAYER_IDENTITY_CODES.providerInvalid,
      MAXIMUM_PROVIDER_IDENTIFIER_CODE_POINTS
    ),
    externalValue: assertCanonicalText(
      input.externalValue,
      PLAYER_IDENTITY_CODES.externalIdInvalid,
      MAXIMUM_PROVIDER_IDENTIFIER_CODE_POINTS
    ),
  });
}

module.exports = {
  CANONICAL_UUID_PATTERN,
  MAXIMUM_PLAYER_NAME_CODE_POINTS,
  MAXIMUM_PROVIDER_IDENTIFIER_CODE_POINTS,
  PLAYER_IDENTITY_CODES,
  PLAYER_STATUSES,
  PlayerIdentityPolicyError,
  assertStablePlayerId,
  createGlobalPlayerRecord,
  createPlayerExternalIdRecord,
  validateExternalIdentifierLookup,
};
