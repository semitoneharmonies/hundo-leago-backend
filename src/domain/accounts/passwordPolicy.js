const MINIMUM_PASSWORD_CODE_POINTS = 6;
const MAXIMUM_PASSWORD_CODE_POINTS = 256;
const MAXIMUM_PASSWORD_UTF8_BYTES = 1024;

const PASSWORD_POLICY_CODES = Object.freeze({
  typeInvalid: "PASSWORD_TYPE_INVALID",
  unicodeInvalid: "PASSWORD_UNICODE_INVALID",
  tooShort: "PASSWORD_TOO_SHORT",
  tooLong: "PASSWORD_TOO_LONG",
  tooLarge: "PASSWORD_TOO_LARGE",
  confirmationInvalid:
    "PASSWORD_CONFIRMATION_INVALID",
  confirmationMismatch:
    "PASSWORD_CONFIRMATION_MISMATCH",
});

class PasswordPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted password is invalid.");
    this.name = "PasswordPolicyError";
    this.code = "PASSWORD_POLICY_INVALID";
    this.reasonCode = reasonCode;
  }
}

function hasValidUnicodeScalarSequence(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const isHighSurrogate =
      codeUnit >= 0xd800 && codeUnit <= 0xdbff;
    const isLowSurrogate =
      codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

    if (isHighSurrogate) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (isLowSurrogate) {
      return false;
    }
  }
  return true;
}

function inspectPassword(password) {
  if (typeof password !== "string") {
    return Object.freeze({
      ok: false,
      reasonCode:
        PASSWORD_POLICY_CODES.typeInvalid,
    });
  }
  if (!hasValidUnicodeScalarSequence(password)) {
    return Object.freeze({
      ok: false,
      reasonCode:
        PASSWORD_POLICY_CODES.unicodeInvalid,
    });
  }

  const codePointCount = Array.from(password).length;
  if (
    codePointCount <
    MINIMUM_PASSWORD_CODE_POINTS
  ) {
    return Object.freeze({
      ok: false,
      reasonCode: PASSWORD_POLICY_CODES.tooShort,
    });
  }
  if (
    codePointCount >
    MAXIMUM_PASSWORD_CODE_POINTS
  ) {
    return Object.freeze({
      ok: false,
      reasonCode: PASSWORD_POLICY_CODES.tooLong,
    });
  }
  if (
    Buffer.byteLength(password, "utf8") >
    MAXIMUM_PASSWORD_UTF8_BYTES
  ) {
    return Object.freeze({
      ok: false,
      reasonCode: PASSWORD_POLICY_CODES.tooLarge,
    });
  }

  return Object.freeze({
    ok: true,
    reasonCode: null,
  });
}

function assertPassword(password) {
  const result = inspectPassword(password);
  if (!result.ok) {
    throw new PasswordPolicyError(
      result.reasonCode
    );
  }
  return password;
}

function assertPasswordConfirmation(
  password,
  confirmation
) {
  assertPassword(password);
  if (typeof confirmation !== "string") {
    throw new PasswordPolicyError(
      PASSWORD_POLICY_CODES.confirmationInvalid
    );
  }
  if (password !== confirmation) {
    throw new PasswordPolicyError(
      PASSWORD_POLICY_CODES.confirmationMismatch
    );
  }
  return password;
}

module.exports = {
  MAXIMUM_PASSWORD_CODE_POINTS,
  MAXIMUM_PASSWORD_UTF8_BYTES,
  MINIMUM_PASSWORD_CODE_POINTS,
  PASSWORD_POLICY_CODES,
  PasswordPolicyError,
  assertPassword,
  assertPasswordConfirmation,
  hasValidUnicodeScalarSequence,
  inspectPassword,
};
