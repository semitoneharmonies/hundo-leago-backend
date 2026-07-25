const MAXIMUM_EMAIL_CODE_POINTS = 320;
const MAXIMUM_DISPLAY_NAME_CODE_POINTS = 50;
const EMAIL_PATTERN =
  /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/u;
const FORBIDDEN_DISPLAY_NAME_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const ACCOUNT_REGISTRATION_CODES = Object.freeze({
  inputInvalid: "ACCOUNT_REGISTRATION_INPUT_INVALID",
  emailInvalid: "ACCOUNT_EMAIL_INVALID",
  displayNameInvalid: "ACCOUNT_DISPLAY_NAME_INVALID",
});

class AccountRegistrationPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted account details are invalid.");
    this.name = "AccountRegistrationPolicyError";
    this.code = ACCOUNT_REGISTRATION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new AccountRegistrationPolicyError(
    reasonCode
  );
}

function codePointLength(value) {
  return Array.from(value).length;
}

function normalizeEmail(email) {
  if (typeof email !== "string") {
    fail(ACCOUNT_REGISTRATION_CODES.emailInvalid);
  }
  const display = email.trim();
  if (
    display.length === 0 ||
    codePointLength(display) >
      MAXIMUM_EMAIL_CODE_POINTS ||
    !EMAIL_PATTERN.test(display)
  ) {
    fail(ACCOUNT_REGISTRATION_CODES.emailInvalid);
  }
  const [localPart, domainPart, ...rest] =
    display.split("@");
  if (
    rest.length > 0 ||
    localPart.length === 0 ||
    domainPart.length === 0 ||
    domainPart.startsWith(".") ||
    domainPart.endsWith(".") ||
    domainPart.includes("..")
  ) {
    fail(ACCOUNT_REGISTRATION_CODES.emailInvalid);
  }
  const normalized = display.toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 320
  ) {
    fail(ACCOUNT_REGISTRATION_CODES.emailInvalid);
  }
  return Object.freeze({ display, normalized });
}

function normalizeDisplayName(displayName) {
  if (typeof displayName !== "string") {
    fail(
      ACCOUNT_REGISTRATION_CODES.displayNameInvalid
    );
  }
  const display = displayName.trim();
  if (
    display.length === 0 ||
    codePointLength(display) >
      MAXIMUM_DISPLAY_NAME_CODE_POINTS ||
    FORBIDDEN_DISPLAY_NAME_PATTERN.test(display)
  ) {
    fail(
      ACCOUNT_REGISTRATION_CODES.displayNameInvalid
    );
  }
  const normalized = display.toLowerCase();
  if (
    normalized.length < 1 ||
    normalized.length > 100
  ) {
    fail(
      ACCOUNT_REGISTRATION_CODES.displayNameInvalid
    );
  }
  return Object.freeze({ display, normalized });
}

function validateAccountIdentity(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(ACCOUNT_REGISTRATION_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = ["displayName", "email"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(ACCOUNT_REGISTRATION_CODES.inputInvalid);
  }
  const email = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(
    input.displayName
  );
  return Object.freeze({
    emailDisplay: email.display,
    emailNormalized: email.normalized,
    displayName: displayName.display,
    displayNameNormalized:
      displayName.normalized,
  });
}

function validateAccountRegistration(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(ACCOUNT_REGISTRATION_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [
    "displayName",
    "email",
    "password",
    "passwordConfirmation",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(ACCOUNT_REGISTRATION_CODES.inputInvalid);
  }
  const email = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(
    input.displayName
  );
  const result = {
    emailDisplay: email.display,
    emailNormalized: email.normalized,
    displayName: displayName.display,
    displayNameNormalized:
      displayName.normalized,
  };
  Object.defineProperty(result, "password", {
    configurable: false,
    enumerable: false,
    value: input.password,
    writable: false,
  });
  Object.defineProperty(result, "passwordConfirmation", {
    configurable: false,
    enumerable: false,
    value: input.passwordConfirmation,
    writable: false,
  });
  return Object.freeze(result);
}

module.exports = {
  ACCOUNT_REGISTRATION_CODES,
  MAXIMUM_DISPLAY_NAME_CODE_POINTS,
  MAXIMUM_EMAIL_CODE_POINTS,
  AccountRegistrationPolicyError,
  normalizeDisplayName,
  normalizeEmail,
  validateAccountIdentity,
  validateAccountRegistration,
};
