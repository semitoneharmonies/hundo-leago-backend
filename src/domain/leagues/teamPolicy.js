const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_TEAM_NAME_CODE_POINTS = 35;
const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 128;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

class TeamPolicyError extends Error {
  constructor(reasonCode) {
    super("The team request is invalid.");
    this.name = "TeamPolicyError";
    this.code = "TEAM_INPUT_INVALID";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new TeamPolicyError(reasonCode);
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

function validateStableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("stable_id_invalid");
  }
  return value;
}

function validateIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAXIMUM_IDEMPOTENCY_KEY_LENGTH ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    fail("idempotency_key_invalid");
  }
  return value;
}

function validateTeamName(value) {
  if (typeof value !== "string") fail("team_name_invalid");
  const name = value.trim();
  const nameNormalized = name.toLowerCase();
  if (
    name.length < 1 ||
    Array.from(name).length > MAXIMUM_TEAM_NAME_CODE_POINTS ||
    FORBIDDEN_TEXT_PATTERN.test(name) ||
    nameNormalized.length > 120
  ) {
    fail("team_name_invalid");
  }
  return Object.freeze({ name, nameNormalized });
}

function validateTeamCreationInput(input) {
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, "name")
  ) {
    fail("team_creation_input_invalid");
  }
  return validateTeamName(input.name);
}

module.exports = {
  FORBIDDEN_TEXT_PATTERN,
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  MAXIMUM_TEAM_NAME_CODE_POINTS,
  TeamPolicyError,
  UUID_PATTERN,
  validateIdempotencyKey,
  validateStableId,
  validateTeamCreationInput,
  validateTeamName,
};
