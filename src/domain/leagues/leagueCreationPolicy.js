const MAXIMUM_LEAGUE_NAME_CODE_POINTS = 120;
const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 128;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

class LeagueCreationPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted league-creation details are invalid.");
    this.name = "LeagueCreationPolicyError";
    this.code = "LEAGUE_CREATION_INPUT_INVALID";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new LeagueCreationPolicyError(reasonCode);
}

function validateLeagueCreationInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, "name") ||
    typeof input.name !== "string"
  ) {
    fail("league_input_invalid");
  }
  const name = input.name.trim();
  if (
    name.length === 0 ||
    Array.from(name).length > MAXIMUM_LEAGUE_NAME_CODE_POINTS ||
    FORBIDDEN_TEXT_PATTERN.test(name)
  ) {
    fail("league_name_invalid");
  }
  const nameNormalized = name.toLowerCase();
  if (
    nameNormalized.length < 1 ||
    Array.from(nameNormalized).length >
      MAXIMUM_LEAGUE_NAME_CODE_POINTS ||
    nameNormalized.length > MAXIMUM_LEAGUE_NAME_CODE_POINTS
  ) {
    fail("league_name_invalid");
  }
  return Object.freeze({ name, nameNormalized });
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

module.exports = {
  FORBIDDEN_TEXT_PATTERN,
  LeagueCreationPolicyError,
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  MAXIMUM_LEAGUE_NAME_CODE_POINTS,
  validateIdempotencyKey,
  validateLeagueCreationInput,
};
