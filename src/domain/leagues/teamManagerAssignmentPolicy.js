const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 128;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

class TeamManagerAssignmentPolicyError extends Error {
  constructor(reasonCode) {
    super("The team-manager assignment request is invalid.");
    this.name = "TeamManagerAssignmentPolicyError";
    this.code = "TEAM_MANAGER_ASSIGNMENT_INPUT_INVALID";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new TeamManagerAssignmentPolicyError(reasonCode);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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

function validateProposalInput(input) {
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, "userId")
  ) {
    fail("proposal_input_invalid");
  }
  return Object.freeze({ userId: validateStableId(input.userId) });
}

function validateDecisionInput(input) {
  if (!isPlainObject(input) || Object.keys(input).length !== 0) {
    fail("decision_input_invalid");
  }
  return Object.freeze({});
}

function validateRemovalInput(input) {
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, "assignmentId")
  ) {
    fail("removal_input_invalid");
  }
  return Object.freeze({
    assignmentId: validateStableId(input.assignmentId),
  });
}

function validateExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("expected_version_invalid");
  }
  return value;
}

module.exports = {
  FORBIDDEN_TEXT_PATTERN,
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  TeamManagerAssignmentPolicyError,
  UUID_PATTERN,
  validateDecisionInput,
  validateExpectedVersion,
  validateIdempotencyKey,
  validateProposalInput,
  validateRemovalInput,
  validateStableId,
};
