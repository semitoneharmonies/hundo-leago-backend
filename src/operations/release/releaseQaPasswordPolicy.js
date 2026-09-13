const {
  PASSWORD_POLICY_CODES,
  PasswordPolicyError,
  inspectPassword,
} = require("../../domain/accounts/passwordPolicy");

function inspectReleaseQaPassword(password) {
  const result = inspectPassword(password);
  if (result.ok) return result;
  if (
    result.reasonCode === PASSWORD_POLICY_CODES.tooShort &&
    typeof password === "string" &&
    Array.from(password).length > 0
  ) {
    return Object.freeze({ ok: true, reasonCode: null });
  }
  return result;
}

function assertReleaseQaPassword(password) {
  const result = inspectReleaseQaPassword(password);
  if (result.ok) return password;
  throw new PasswordPolicyError(result.reasonCode);
}

module.exports = {
  assertReleaseQaPassword,
  inspectReleaseQaPassword,
};
