const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class CommissionerAssignmentPolicyError extends Error {
  constructor() {
    super("The commissioner-assignment request is invalid.");
    this.name = "CommissionerAssignmentPolicyError";
    this.code = "COMMISSIONER_ASSIGNMENT_INPUT_INVALID";
  }
}

function invalid() {
  throw new CommissionerAssignmentPolicyError();
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
    invalid();
  }
  return value;
}

function validateIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function validateProposalInput(input) {
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, "userId")
  ) {
    invalid();
  }
  return Object.freeze({
    userId: validateStableId(input.userId),
  });
}

function validateDecisionInput(input) {
  if (!isPlainObject(input) || Object.keys(input).length !== 0) {
    invalid();
  }
  return Object.freeze({});
}

module.exports = {
  CommissionerAssignmentPolicyError,
  UUID_PATTERN,
  validateDecisionInput,
  validateIdempotencyKey,
  validateProposalInput,
  validateStableId,
};
