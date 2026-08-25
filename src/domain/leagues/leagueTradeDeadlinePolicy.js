const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class LeagueTradeDeadlinePolicyError extends Error {
  constructor(reasonCode) {
    super("The league trade-deadline request is invalid.");
    this.name = "LeagueTradeDeadlinePolicyError";
    this.code = "LEAGUE_TRADE_DEADLINE_INPUT_INVALID";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new LeagueTradeDeadlinePolicyError(reasonCode);
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

function validateLeagueTradeDeadlineInput(value) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(
      value,
      "tradeDeadlineAtMs"
    ) ||
    !Number.isSafeInteger(value.tradeDeadlineAtMs) ||
    value.tradeDeadlineAtMs < 0
  ) {
    fail("body_invalid");
  }
  return Object.freeze({
    tradeDeadlineAtMs: value.tradeDeadlineAtMs,
  });
}

function validateLeagueTradeDeadlineLeagueId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail("league_id_invalid");
  }
  return value;
}

function validateLeagueTradeDeadlineExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("expected_version_invalid");
  }
  return value;
}

function validateLeagueTradeDeadlineIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    fail("idempotency_key_invalid");
  }
  return value;
}

module.exports = {
  LeagueTradeDeadlinePolicyError,
  UUID_PATTERN,
  validateLeagueTradeDeadlineExpectedVersion,
  validateLeagueTradeDeadlineIdempotencyKey,
  validateLeagueTradeDeadlineInput,
  validateLeagueTradeDeadlineLeagueId,
};
